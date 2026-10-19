/**
 * test/updater.test.mjs — the desktop shell's automatic updater.
 *
 * desktop/updater.js takes every effect it has as an argument, so these tests
 * drive the real module through each path — release lookup, the signed
 * manifest, the download and its hash, the Windows and macOS hand-offs — with
 * a fake GitHub, a fake `ditto`, a fake PowerShell and a key made for the run.
 * No network, no Electron, no real release.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ATTEMPT_FILE, createUpdater, downloadToFile, isStrongPublicKey, MAC_NEW_SUFFIX, MAC_SWAP_SCRIPT, macReplaceCheck,
  manifestAsset, openReleaseDownload, parseSwapResult, PENDING_DIR, publicKeyFrom, readUpdateSettings, RESULT_FILE,
  signatureMatches, signManifest, updateAssetName, verifyReleaseManifest, windowsReplaceCheck, writeUpdateSettings,
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, QUIET_FAILURES_SHOWN, RETRY_INTERVAL_MS,
} from '../desktop/updater.js';
import { RELEASE_API, REPOSITORY } from '../core/updates.mjs';

const PUBLISHER = 'Zelos Example Publisher, Ltd';
const download = (version, name) => `${REPOSITORY}/releases/download/v${version}/${name}`;
const storage = (name) => `https://release-assets.githubusercontent.com/github-production-release-asset/1/${name}?sig=x`;

/** An update key made for this run, as the generator script makes one. */
function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, x: publicKey.export({ format: 'jwk' }).x };
}
const KEY = makeKey();
const OTHER_KEY = makeKey();

/** A release with one update file for this platform, its signed manifest, and a stand-in source zip. */
function fixture(version = '1.9.0', { platform = 'win32', arch = 'x64', payload = crypto.randomBytes(4096), key = KEY } = {}) {
  const name = updateAssetName(version, platform, arch);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const manifest = { version, commit: 'a'.repeat(40), assets: [{ name, size: payload.length, sha256: sha }, { name: 'zelos-source.zip', size: 2048, sha256: '0'.repeat(64) }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const files = new Map([
    [name, payload],
    ['zelos-source.zip', Buffer.alloc(2048, 1)],
    ['release.json', manifestBytes],
    ['release.json.sig', Buffer.from(signManifest(manifestBytes, key.privateKey))],
  ]);
  const release = {
    tag_name: `v${version}`, html_url: `${REPOSITORY}/releases/tag/v${version}`, draft: false, prerelease: false,
    published_at: '2026-10-01T00:00:00Z', body: 'Fixes.',
    assets: [...files].map(([file, bytes]) => ({ name: file, state: 'uploaded', size: bytes.length, browser_download_url: download(version, file) })),
  };
  return { version, release, files, name, payload, sha };
}

/** Replace one release file, keeping GitHub's listed size in step. */
function swapFile(fx, name, bytes) {
  fx.files.set(name, bytes);
  fx.release.assets.find((a) => a.name === name).size = bytes.length;
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
/** Wait on real file and stream work by time, not by turns, so a busy machine is not a failure. */
async function until(predicate, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
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
    publicKeys: [KEY.x],
    windowsPublisher: overrides.publisher ?? '',
    windows: {
      verifySignature: async (file) => {
        signatures.push(file);
        await overrides.duringVerify?.(file);
        const signature = typeof overrides.signature === 'function' ? overrides.signature(file) : overrides.signature;
        return signature ?? { status: 'Valid', publisher: PUBLISHER };
      },
      launchInstaller: (file, onError) => { launched.push(file); overrides.onLaunch?.(onError); },
    },
    fetchImpl: github.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onChange: (state) => states.push(state),
    ...overrides.deps,
  });
  return { updater, github, timers, launched, signatures, states };
}

/** A fake Mac: an installed app bundle, `ditto` that unpacks a JSON "zip", and a recorded swap. */
function macUpdater(fx, overrides = {}) {
  const github = fakeGitHub(fx, overrides.github);
  const timers = fakeTimers();
  const bundlePath = path.join(sandbox, 'Applications', 'Zelos.app');
  fs.mkdirSync(bundlePath, { recursive: true });
  const swaps = [];
  const extracted = [];
  const updater = createUpdater({
    currentVersion: '1.8.1', platform: 'darwin', arch: 'arm64', isPackaged: true,
    settingsFile: path.join(sandbox, 'updates.json'),
    downloadDir: path.join(sandbox, 'userData', PENDING_DIR),
    publicKeys: [KEY.x], pid: 4242,
    mac: {
      bundlePath,
      canReplace: overrides.canReplace ?? (() => ''),
      extractZip: async (zip, dest) => {
        extracted.push(dest);
        // The fake ZIP is JSON naming the apps inside it and their Info.plist values.
        const contents = JSON.parse(fs.readFileSync(zip, 'utf8'));
        for (const [app, info] of Object.entries(contents)) {
          fs.mkdirSync(path.join(dest, app), { recursive: true });
          fs.writeFileSync(path.join(dest, app, 'info.json'), JSON.stringify(info));
        }
        fs.mkdirSync(dest, { recursive: true });
      },
      readBundleInfo: async (app) => (app === bundlePath
        ? { id: 'app.zelos.desktop', version: '1.8.1' }
        : JSON.parse(fs.readFileSync(path.join(app, 'info.json'), 'utf8'))),
      copyApp: async (from, to) => {
        if (overrides.copyRefused) throw new Error('Operation not permitted');
        fs.cpSync(from, to, { recursive: true });
      },
      otherInstances: async () => overrides.others ?? 0,
      launchSwap: (args, onError) => { swaps.push(args); overrides.onSwap?.(onError); },
    },
    fetchImpl: github.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    currentVersion: overrides.currentVersion ?? '1.8.1',
  });
  return { updater, github, timers, swaps, bundlePath, extracted };
}

const macZip = (apps) => Buffer.from(JSON.stringify(apps));

describe('update settings', () => {
  it('default to automatic, and survive a missing, broken or hostile file', () => {
    const file = path.join(sandbox, 'updates.json');
    assert.deepEqual(readUpdateSettings(file), { auto: true, skipped: '' });
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readUpdateSettings(file), { auto: true, skipped: '' });
    fs.writeFileSync(file, JSON.stringify({ auto: 'false', extra: 'ignored' }));
    assert.deepEqual(readUpdateSettings(file), { auto: true, skipped: '' }, 'only a real false turns updates off');
    writeUpdateSettings(file, { auto: false, extra: 'dropped' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { auto: false });
    assert.deepEqual(readUpdateSettings(file), { auto: false, skipped: '' });
    writeUpdateSettings(file, { auto: true, skipped: '1.9.2' });
    assert.deepEqual(readUpdateSettings(file), { auto: true, skipped: '1.9.2' });
    fs.writeFileSync(file, JSON.stringify({ auto: true, skipped: '../../etc' }));
    assert.deepEqual(readUpdateSettings(file), { auto: true, skipped: '' }, 'only a real version can be skipped');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('the signed release manifest', () => {
  const manifest = Buffer.from(JSON.stringify({ version: '1.9.0', assets: [{ name: 'a.exe', size: 10, sha256: 'b'.repeat(64) }] }));

  it('verifies only with a configured key, over the exact bytes, for the expected version', () => {
    const signature = signManifest(manifest, KEY.privateKey);
    assert.equal(verifyReleaseManifest(manifest, signature, [KEY.x], { version: '1.9.0' }).version, '1.9.0');
    assert.equal(verifyReleaseManifest(manifest, signature, [OTHER_KEY.x, KEY.x], { version: '1.9.0' }).version, '1.9.0', 'any configured key will do');
    assert.throws(() => verifyReleaseManifest(manifest, signature, [OTHER_KEY.x], { version: '1.9.0' }), /not signed with the Zelos update key/);
    assert.throws(() => verifyReleaseManifest(manifest, signature, [], { version: '1.9.0' }), /not signed/);
    assert.throws(() => verifyReleaseManifest(manifest, signature, ['not-a-key', 42], { version: '1.9.0' }), /not signed/);
    const altered = Buffer.from(manifest.toString().replace('"size":10', '"size":11'));
    assert.throws(() => verifyReleaseManifest(altered, signature, [KEY.x], { version: '1.9.0' }), /not signed/);
    assert.throws(() => verifyReleaseManifest(manifest, signature, [KEY.x], { version: '1.9.1' }), /do not match this release/,
      'an older signed manifest cannot be replayed as a newer release');
    for (const bad of ['', 'not base64!', signature.slice(0, 40), `${signature.trim()}AA`, null]) {
      assert.throws(() => verifyReleaseManifest(manifest, bad, [KEY.x], { version: '1.9.0' }), /signature/, String(bad));
    }
  });

  it('refuses weak public keys a signature could be forged against', () => {
    const hex = (h) => Buffer.from(h, 'hex');
    for (const weak of [
      '0100000000000000000000000000000000000000000000000000000000000000', // the identity
      '0000000000000000000000000000000000000000000000000000000000000000', // all zero — a likely placeholder
      '0000000000000000000000000000000000000000000000000000000000000080',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // non-canonical
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    ]) {
      assert.equal(isStrongPublicKey(hex(weak)), false, weak);
      assert.equal(publicKeyFrom(hex(weak).toString('base64url')), null, weak);
    }
    // The forgery that makes this matter: under the identity key, OpenSSL
    // accepts R = identity, S = 0 for any message.
    const identity = hex('0100000000000000000000000000000000000000000000000000000000000000');
    const forged = Buffer.concat([identity, Buffer.alloc(32)]).toString('base64');
    const manifest = Buffer.from(JSON.stringify({ version: '9.9.9', assets: [] }));
    assert.throws(() => verifyReleaseManifest(manifest, forged, [identity.toString('base64url')], { version: '9.9.9' }), /not signed/);
    for (let i = 0; i < 50; i++) {
      assert.equal(isStrongPublicKey(Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url')), true);
    }
  });

  it('reads public keys only in their exact form', () => {
    assert.ok(publicKeyFrom(KEY.x));
    for (const bad of ['', KEY.x.slice(1), `${KEY.x}=`, `+${KEY.x.slice(1)}`, 42, null, undefined]) {
      assert.equal(publicKeyFrom(bad), null, String(bad));
    }
  });

  it('lists a file only once and well formed', () => {
    const one = { assets: [{ name: 'a.exe', size: 10, sha256: 'b'.repeat(64) }] };
    assert.deepEqual(manifestAsset(one, 'a.exe'), { name: 'a.exe', size: 10, sha256: 'b'.repeat(64) });
    assert.equal(manifestAsset({ assets: [...one.assets, ...one.assets] }, 'a.exe'), null, 'a duplicate entry is ambiguous');
    for (const entry of [{ size: 0 }, { size: -1 }, { size: '10' }, { sha256: 'B'.repeat(64) }, { sha256: 'b'.repeat(63) }]) {
      assert.equal(manifestAsset({ assets: [{ ...one.assets[0], ...entry }] }, 'a.exe'), null, JSON.stringify(entry));
    }
    assert.equal(manifestAsset({}, 'a.exe'), null);
  });

  it('names one update file per platform and architecture', () => {
    assert.equal(updateAssetName('1.9.0', 'darwin', 'arm64'), 'Zelos-1.9.0-arm64.zip');
    assert.equal(updateAssetName('1.9.0', 'win32', 'x64'), 'Zelos-1.9.0-setup-x64.exe');
    assert.equal(updateAssetName('1.9.0', 'linux', 'x64'), null);
  });

  it('trusts an Authenticode signature only when Valid and naming exactly the configured publisher', () => {
    assert.equal(signatureMatches({ status: 'Valid', publisher: 'Example, Ltd' }, 'Example, Ltd'), true);
    for (const publisher of ['Example, Ltd Evil', 'example, ltd', ' Example, Ltd', '', undefined]) {
      assert.equal(signatureMatches({ status: 'Valid', publisher }, 'Example, Ltd'), false, String(publisher));
    }
    for (const status of ['NotSigned', 'HashMismatch', 'UnknownError', 'NotTrusted', '']) {
      assert.equal(signatureMatches({ status, publisher: 'Example, Ltd' }, 'Example, Ltd'), false, status);
    }
    assert.equal(signatureMatches(null, 'Example, Ltd'), false);
  });
});

describe('release downloads', () => {
  it('start only at this repository\'s release downloads and follow redirects only to GitHub', async () => {
    const fx = fixture();
    const { fetchImpl, seen } = fakeGitHub(fx);
    const response = await openReleaseDownload(download(fx.version, 'release.json'), { fetchImpl });
    assert.match(await response.text(), /"version": "1\.9\.0"/);
    assert.equal(seen[0].options.redirect, 'manual');
    assert.equal(seen[1].url, storage('release.json'));

    for (const url of ['https://github.com/someone-else/zelos/releases/download/v1.9.0/x.exe',
      'http://github.com/HoosAI-Platform/zelos/releases/download/v1.9.0/x.exe', 'https://evil.example/x', 42]) {
      await assert.rejects(openReleaseDownload(url, { fetchImpl }), /could not be verified/);
    }
    const bounce = (location) => async () => new Response(null, { status: 302, headers: { location } });
    for (const location of ['https://evil.example/x.exe', 'http://objects.githubusercontent.com/x', 'https://user:pw@github.com/x',
      'https://objects.githubusercontent.com.evil.example/x', 'https://github.com:8443/x', 'javascript:alert(1)', '']) {
      const evil = fakeGitHub(fx, { override: { [download(fx.version, 'release.json')]: bounce(location) } });
      await assert.rejects(openReleaseDownload(download(fx.version, 'release.json'), { fetchImpl: evil.fetchImpl }), /redirected somewhere unexpected/, location);
      assert.equal(evil.seen.length, 1, `${location} must not be contacted`);
    }
    const loop = async () => new Response(null, { status: 302, headers: { location: download(fx.version, 'release.json') } });
    await assert.rejects(openReleaseDownload(download(fx.version, 'release.json'), { fetchImpl: loop }), /too many times/);
  });

  it('write a file only when it arrives whole, at exactly the listed size', async () => {
    const fx = fixture();
    const { fetchImpl } = fakeGitHub(fx);
    const file = path.join(sandbox, 'dl', 'installer.exe');
    const url = download(fx.version, fx.name);
    const progress = [];
    const digest = await downloadToFile(url, file, { fetchImpl, expectedSize: fx.payload.length, onProgress: (p) => progress.push(p) });
    assert.equal(digest, fx.sha);
    assert.deepEqual(fs.readFileSync(file), fx.payload);
    assert.equal(progress.at(-1), 1);
    assert.equal(fs.existsSync(`${file}.partial`), false);

    fs.rmSync(file);
    await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: fx.payload.length + 1 }), /unexpected size/);
    await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: fx.payload.length - 1 }), /unexpected size/);
    const liar = fakeGitHub(fx, { override: { [storage(fx.name)]: async () => new Response(Buffer.concat([fx.payload, Buffer.alloc(10)])) } });
    await assert.rejects(downloadToFile(url, file, { fetchImpl: liar.fetchImpl, expectedSize: fx.payload.length }), /unexpected size/);
    const short = fakeGitHub(fx, { override: { [storage(fx.name)]: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(fx.payload.subarray(0, 100)); controller.close(); },
    })) } });
    await assert.rejects(downloadToFile(url, file, { fetchImpl: short.fetchImpl, expectedSize: fx.payload.length }), /incomplete/);
    assert.equal(fs.existsSync(file), false, 'nothing that looks finished is left behind');
    assert.equal(fs.existsSync(`${file}.partial`), false);
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, undefined]) {
      await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: size }), /unexpected size/);
    }
  });

  it('abandon a download that stops sending', async () => {
    const fx = fixture();
    let stallTimer = null;
    const hung = fakeGitHub(fx, { override: { [storage(fx.name)]: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10)); signal.addEventListener('abort', () => controller.error(new Error('aborted'))); },
    })) } });
    const file = path.join(sandbox, 'dl', 'installer.exe');
    const pending = downloadToFile(download(fx.version, fx.name), file, {
      fetchImpl: hung.fetchImpl, expectedSize: fx.payload.length,
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
    ['a source checkout', { platform: 'darwin', arch: 'arm64', isPackaged: false }, /runs from source/],
    ['Linux', { platform: 'linux', arch: 'x64', isPackaged: true }, /Mac and Windows/],
    ['a build with no update key', { platform: 'darwin', arch: 'arm64', isPackaged: true, publicKeys: [] }, /no Zelos update key/],
    ['a build with only a malformed key', { platform: 'win32', arch: 'x64', isPackaged: true, publicKeys: ['nope'] }, /no Zelos update key/],
    ['32-bit Windows', { platform: 'win32', arch: 'ia32', isPackaged: true }, /processor/],
    ['a Mac app it cannot replace', { platform: 'darwin', arch: 'arm64', isPackaged: true, canReplace: () => 'Move Zelos to your Applications folder.' }, /Applications folder/],
  ];
  for (const [name, opts, reason] of cases) {
    it(`stays off for ${name}, says why, and contacts nobody`, async () => {
      const seen = [];
      const timers = fakeTimers();
      const { canReplace, ...rest } = opts;
      const updater = createUpdater({
        currentVersion: '1.8.1', settingsFile: path.join(sandbox, 'updates.json'), downloadDir: path.join(sandbox, PENDING_DIR),
        publicKeys: [KEY.x],
        mac: { bundlePath: '/Applications/Zelos.app', canReplace: canReplace ?? (() => ''), extractZip: async () => {}, readBundleInfo: async () => ({}), copyApp: async () => {}, launchSwap: () => {} },
        windows: { verifySignature: async () => ({}), launchInstaller: () => {} },
        fetchImpl: async (...args) => { seen.push(args); return new Response('', { status: 500 }); },
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        ...rest,
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

  it('refuses a download folder it does not own, because it empties it', () => {
    for (const platform of ['win32', 'darwin']) {
      assert.throws(() => createUpdater({ platform, arch: 'x64', isPackaged: true, settingsFile: path.join(sandbox, 'u.json'), downloadDir: sandbox }), /dedicated/);
    }
  });

  it('turns Windows updating off for an all-users install or a folder it cannot write', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    const writable = { writeFileSync() {}, rmSync() {} };
    if (process.platform === 'win32') {
      assert.match(windowsReplaceCheck({ installDir: 'C:\\Program Files\\Zelos', env, fsImpl: writable })(), /all users/);
    }
    assert.equal(windowsReplaceCheck({ installDir: path.join(sandbox, 'Programs', 'Zelos'), env, fsImpl: writable })(), '');
    const locked = { writeFileSync() { throw new Error('EPERM'); }, rmSync() {} };
    assert.match(windowsReplaceCheck({ installDir: path.join(sandbox, 'Zelos'), env, fsImpl: locked })(), /cannot change/);
  });

  it('explains a Mac app that is translocated, on the disk image, or in a folder it cannot change', () => {
    const writable = macReplaceCheck({ access: () => {} });
    assert.equal(writable('/Applications/Zelos.app'), '');
    assert.match(writable('/private/var/folders/x/AppTranslocation/ABC/d/Zelos.app'), /temporary location/);
    assert.match(writable('/Applications/Zelos.app/Contents'), /could not find its own app/);
    const readOnly = macReplaceCheck({ access: () => { throw new Error('EACCES'); } });
    assert.match(readOnly('/Volumes/Zelos 1.9.0/Zelos.app'), /cannot change/);
  });
});

describe('the Windows updater', () => {
  it('verifies the signed manifest before downloading, then hands the exit to the installer', async () => {
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

    const file = path.join(sandbox, PENDING_DIR, '1.9.0', fx.name);
    assert.deepEqual(fs.readFileSync(file), fx.payload);
    assert.deepEqual(h.github.seen.map((s) => s.url).filter((u) => !u.includes('githubusercontent')),
      [RELEASE_API, download('1.9.0', 'release.json'), download('1.9.0', 'release.json.sig'), download('1.9.0', fx.name)],
      'the release record, its manifest and signature, then this machine\'s installer — in that order');
    for (const { options } of h.github.seen) assert.equal(options.body, undefined);
    assert.equal(h.signatures.length, 0, 'no Authenticode check without a configured publisher');

    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [file]);
    assert.equal(h.updater.state().status, 'installing');
    assert.equal(fs.readFileSync(path.join(sandbox, ATTEMPT_FILE), 'utf8'), '1.9.0\n', 'the next launch can tell whether it landed');
  });

  it('the next launch reports an update that did not land, and keeps saying so', async () => {
    fs.writeFileSync(path.join(sandbox, ATTEMPT_FILE), '1.9.0\n');
    const h = windowsUpdater(fixture());
    const state = await h.updater.start();
    assert.match(state.installProblem, /Zelos 1\.9\.0 was not installed, so you are still on 1\.8\.1/);
    assert.equal(fs.existsSync(path.join(sandbox, ATTEMPT_FILE)), false, 'said once per failure');
    await h.updater.checkNow();
    assert.match(h.updater.state().installProblem, /was not installed/, 'a later check does not wipe it');

    fs.writeFileSync(path.join(sandbox, ATTEMPT_FILE), '1.8.1\n');
    assert.equal((await windowsUpdater(fixture()).updater.start()).installProblem, '', 'a landed update is not news');
  });

  for (const [what, setup, message] of [
    ['a release signed with another key', (fx) => swapFile(fx, 'release.json.sig', Buffer.from(signManifest(fx.files.get('release.json'), OTHER_KEY.privateKey))), /not signed with the Zelos update key/],
    ['a manifest altered after signing', (fx) => swapFile(fx, 'release.json', Buffer.from(fx.files.get('release.json').toString().replace(fx.sha, 'f'.repeat(64)))), /not signed with the Zelos update key/],
    ['a release with no signature', (fx) => { fx.release.assets = fx.release.assets.filter((a) => a.name !== 'release.json.sig'); }, /no automatic update/],
    ['a signed manifest for another version', (fx) => {
      const old = fixture('1.8.5');
      swapFile(fx, 'release.json', old.files.get('release.json'));
      swapFile(fx, 'release.json.sig', old.files.get('release.json.sig'));
    }, /do not match this release/],
    ['a manifest that does not list this installer', (fx) => {
      const bytes = Buffer.from(JSON.stringify({ version: '1.9.0', assets: [] }));
      swapFile(fx, 'release.json', bytes);
      swapFile(fx, 'release.json.sig', Buffer.from(signManifest(bytes, KEY.privateKey)));
    }, /do not list this update/],
    ['an installer whose size differs from the signed one', (fx) => swapFile(fx, fx.name, Buffer.concat([fx.payload, Buffer.alloc(1)])), /do not list this update/],
  ]) {
    it(`refuses ${what} without downloading the installer`, async () => {
      const fx = fixture();
      setup(fx);
      const h = windowsUpdater(fx);
      await h.updater.start();
      await h.updater.checkNow();
      await until(() => h.updater.state().status === 'error', 'the refusal');
      assert.match(h.updater.state().error, message);
      assert.ok(!h.github.seen.some((s) => s.url === download('1.9.0', fx.name)), 'the installer is never requested');
      assert.equal(h.updater.install(), false);
    });
  }

  it('deletes an installer whose bytes differ from the signed hash', async () => {
    const fx = fixture();
    const tampered = Buffer.from(fx.payload);
    tampered[0] ^= 0xff;
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.name)]: async () => new Response(tampered) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'error', 'the refusal');
    assert.match(h.updater.state().error, /does not match the signed release/);
    assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false, 'the refused installer is deleted');
    assert.equal(h.updater.install(), false);
  });

  it('with a Windows publisher configured, also requires that Authenticode signature', async () => {
    for (const [signature, ok] of [
      [{ status: 'Valid', publisher: PUBLISHER }, true],
      [{ status: 'NotSigned', publisher: '' }, false],
      [{ status: 'Valid', publisher: 'Someone Else Ltd' }, false],
    ]) {
      const h = windowsUpdater(fixture(), { publisher: PUBLISHER, signature });
      await h.updater.start();
      await h.updater.checkNow();
      await until(() => ['ready', 'error'].includes(h.updater.state().status), 'the verdict');
      assert.equal(h.updater.state().status, ok ? 'ready' : 'error', JSON.stringify(signature));
      if (ok) {
        assert.equal(await h.updater.prepareInstall(), true);
        assert.equal(h.signatures.length, 2, 'checked again when the restart is chosen');
      } else {
        assert.match(h.updater.state().error, /not signed by the Zelos publisher/);
      }
      fs.rmSync(path.join(sandbox, PENDING_DIR), { recursive: true, force: true });
    }
  });

  it('re-checks a waiting installer before restarting, and drops one changed since download', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const file = path.join(sandbox, PENDING_DIR, '1.9.0', fx.name);
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
    const file = path.join(sandbox, PENDING_DIR, '1.9.0', fx.name);
    const swapped = Buffer.from(fx.payload);
    swapped[10] ^= 1;
    fs.writeFileSync(file, swapped);
    const failures = [];
    assert.equal(h.updater.install({ onFailure: (err) => failures.push(err.message) }), false);
    assert.deepEqual(h.launched, []);
    assert.match(failures[0], /changed before it could be installed/);
  });

  it('offers the banner once an update is ready, until it is put off or skipped', async () => {
    const h = windowsUpdater(fixture());
    await h.updater.start();
    assert.equal(h.updater.state().banner, '');
    await h.updater.checkNow();
    assert.equal(h.updater.state().banner, '', 'not while it is still downloading');
    await until(() => h.updater.state().status === 'ready', 'the download');
    assert.equal(h.updater.state().banner, '1.9.0');

    assert.equal(h.updater.snoozeBanner().banner, '', 'Remind me later hides it');
    assert.equal(readUpdateSettings(path.join(sandbox, 'updates.json')).skipped, '', 'and is not saved');
    const next = windowsUpdater(fixture());
    await next.updater.start();
    await next.updater.checkNow();
    await until(() => next.updater.state().status === 'ready', 'the download after reopening');
    assert.equal(next.updater.state().banner, '1.9.0', 'reopening Zelos brings a put-off banner back');

    assert.equal(next.updater.skipBanner().banner, '', 'Skip this version hides it');
    assert.equal(readUpdateSettings(path.join(sandbox, 'updates.json')).skipped, '1.9.0');
    next.updater.setAuto(true);
    assert.equal(readUpdateSettings(path.join(sandbox, 'updates.json')).skipped, '1.9.0', 'flipping the switch keeps the skip');
    const later = windowsUpdater(fixture());
    await later.updater.start();
    await later.updater.checkNow();
    await until(() => later.updater.state().status === 'ready', 'the download after reopening again');
    assert.equal(later.updater.state().banner, '', 'a skipped version stays skipped across launches');
    assert.equal(later.updater.state().status, 'ready', 'and can still be installed from Settings');

    const newer = windowsUpdater(fixture('1.9.1'));
    await newer.updater.start();
    await newer.updater.checkNow();
    assert.equal(newer.updater.state().banner, '', 'the skipped 1.9.0 is ready again at launch, still skipped');
    await until(() => newer.updater.state().latestVersion === '1.9.1', 'the newer download');
    assert.equal(newer.updater.state().banner, '1.9.1', 'a newer version gets its own banner');
  });

  it('a ready update survives a relaunch with no network request, and the banner with it', async () => {
    const fx = fixture();
    const first = windowsUpdater(fx);
    await first.updater.start();
    await first.updater.checkNow();
    await until(() => first.updater.state().status === 'ready', 'the download');
    first.updater.snoozeBanner();
    first.updater.stop();

    const again = windowsUpdater(fx);
    const state = await again.updater.start();
    assert.equal(state.status, 'ready', 'ready as soon as Zelos opens');
    assert.equal(state.latestVersion, '1.9.0');
    assert.equal(state.releaseUrl, `${REPOSITORY}/releases/tag/v1.9.0`);
    assert.equal(state.notes, 'Fixes.');
    assert.equal(state.banner, '1.9.0', 'a snooze lasts only until Zelos is reopened');
    assert.equal(again.github.seen.length, 0, 'nothing is fetched to know that');

    // The launch check finds the same release and leaves it ready, without downloading it again.
    again.timers.fire(FIRST_CHECK_DELAY_MS);
    await until(() => again.github.seen.length === 1, 'the launch check');
    await settle();
    assert.equal(again.updater.state().status, 'ready');
    assert.equal(again.github.seen.length, 1, 'the installer is not fetched a second time');
    assert.equal(await again.updater.prepareInstall(), true);
    assert.equal(again.updater.install(), true);
  });

  for (const [what, tamper] of [
    ['an installer changed since it was downloaded', (dir, fx) => fs.appendFileSync(path.join(dir, fx.name), 'x')],
    ['a manifest changed since it was downloaded', (dir) => fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '9.9.9', assets: [] }))],
    ['a manifest signed with another key', (dir) => fs.writeFileSync(path.join(dir, 'release.json.sig'), signManifest(fs.readFileSync(path.join(dir, 'release.json')), OTHER_KEY.privateKey))],
    ['a missing signature', (dir) => fs.rmSync(path.join(dir, 'release.json.sig'))],
  ]) {
    it(`does not offer ${what} at the next launch`, async () => {
      const fx = fixture();
      const first = windowsUpdater(fx);
      await first.updater.start();
      await first.updater.checkNow();
      await until(() => first.updater.state().status === 'ready', 'the download');
      first.updater.stop();
      tamper(path.join(sandbox, PENDING_DIR, '1.9.0'), fx);
      const again = windowsUpdater(fx);
      assert.equal((await again.updater.start()).status, 'idle');
      assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false, 'the leftovers are deleted');
    });
  }

  it('does not offer a kept update that is not newer than the running app', async () => {
    const fx = fixture();
    const first = windowsUpdater(fx);
    await first.updater.start();
    await first.updater.checkNow();
    await until(() => first.updater.state().status === 'ready', 'the download');
    first.updater.stop();
    const upgraded = windowsUpdater(fx, { deps: { currentVersion: '1.9.0' } });
    assert.equal((await upgraded.updater.start()).status, 'idle');
    assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false);
  });

  it('keeps checking while an update is ready: a newer release replaces it, a failed check does not', async () => {
    let now = 1_000_000;
    const fx = fixture();
    const h = windowsUpdater(fx, { deps: { now: () => now } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const tick = () => h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000);

    fx.release.prerelease = true; // the next check fails
    now += CHECK_INTERVAL_MS;
    tick().fn();
    await until(() => h.github.seen.filter((x) => x.url === RELEASE_API).length === 2, 'the failing check');
    await settle();
    assert.equal(h.updater.state().status, 'ready', 'a failed check leaves the ready update alone');
    assert.equal(h.updater.state().error, '');

    const newer = fixture('1.9.1');
    fx.release = newer.release;
    fx.files = newer.files;
    fx.version = newer.version;
    now += RETRY_INTERVAL_MS;
    tick().fn();
    await until(() => h.updater.state().status === 'ready' && h.updater.state().latestVersion === '1.9.1', 'the newer download');
    assert.deepEqual(fs.readdirSync(path.join(sandbox, PENDING_DIR)), ['1.9.1'], 'only the newer update is kept');
    assert.ok(fs.existsSync(path.join(sandbox, PENDING_DIR, '1.9.1', 'Zelos-1.9.1-setup-x64.exe')));
    assert.equal(h.updater.state().banner, '1.9.1');
  });

  it('turning automatic updates off while the download is being checked drops it', async () => {
    let h;
    h = windowsUpdater(fixture(), { publisher: PUBLISHER, duringVerify: async () => { h.updater.setAuto(false); } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.signatures.length === 1, 'the signature check');
    await settle();
    await settle();
    assert.equal(h.updater.state().status, 'idle', 'never "ready" with nothing behind it');
    assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false);
    assert.equal(await h.updater.prepareInstall(), false);
  });

  it('gives up on a manifest that never arrives', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx, { github: { override: { [storage('release.json')]: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.github.seen.some((x) => x.url === storage('release.json')), 'the manifest request');
    h.timers.fire(20_000);
    await until(() => h.updater.state().status === 'error', 'the timeout');
    assert.match(h.updater.state().error, /took too long/);
  });

  it('reports an installer that will not start, so the shell can still exit', async () => {
    const h = windowsUpdater(fixture(), { onLaunch: (onError) => onError(new Error('spawn EACCES')) });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const failures = [];
    assert.equal(h.updater.install({ onFailure: (err) => failures.push(err.message) }), true);
    assert.deepEqual(failures, ['spawn EACCES']);
  });

  it('only offers a stable official release, and never one older or the same', async () => {
    for (const patch of [{ prerelease: true }, { draft: true }, { html_url: 'https://evil.example/' }]) {
      const fx = fixture();
      Object.assign(fx.release, patch);
      const h = windowsUpdater(fx);
      await h.updater.start();
      assert.equal((await h.updater.checkNow()).status, 'error');
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
    const h = windowsUpdater(fixture());
    await h.updater.start();
    h.updater.setAuto(false);
    assert.deepEqual(readUpdateSettings(path.join(sandbox, 'updates.json')), { auto: false, skipped: '' });
    assert.equal((await h.updater.checkNow()).status, 'available');
    assert.equal(h.github.seen.length, 1);
    await h.updater.download();
    await until(() => h.updater.state().status === 'ready', 'the chosen download');
  });

  it('turning automatic updates off stops a download in progress', async () => {
    const fx = fixture();
    let release;
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.name)]: (_url, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve(new Response(fx.payload));
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
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.name)]: (_url, { signal }) => new Promise((_resolve, reject) => {
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

describe('a Restart to update in progress', () => {
  /* The restart is three steps the shell takes in turn: prepareInstall checks
     the ready update, leaveBoard saves drafts and stops the core, and install
     hands over. Nothing the clock does in between may change what is handed
     over (QA, 2026-10-10, TT-3485). */

  /** A Windows updater with 1.9.0 ready, whose later release lookups wait for the test. */
  async function readyWithHeldChecks() {
    let now = 1_000_000;
    const fx = fixture();
    let hold = false;
    const held = [];
    const h = windowsUpdater(fx, {
      deps: { now: () => now },
      // A lookup that ignores being stopped, as a slow network can: only the
      // updater's own bookkeeping can keep its answer from mattering.
      github: { override: { [RELEASE_API]: async () => (hold ? new Promise((resolve) => held.push(resolve)) : Response.json(fx.release)) } },
    });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    hold = true;
    const newer = fixture('1.9.1');
    const tick = () => h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000);
    return {
      ...h, fx, newer, held, tick,
      advance: (ms) => { now += ms; },
      lookups: () => h.github.seen.filter((x) => x.url === RELEASE_API).length,
      // Answer every waiting lookup with 1.9.1, the newer release.
      answer: () => { while (held.length) held.shift()(Response.json(newer.release)); },
    };
  }

  it('a scheduled check that falls during the shutdown does not run, and the prepared update is installed', async () => {
    const h = await readyWithHeldChecks();
    assert.equal(await h.updater.prepareInstall(), true);
    // Drafts are saving; six hours have passed and the clock ticks.
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await settle();
    assert.equal(h.lookups(), 1, 'no check while a restart is under way');
    h.answer();
    await settle();
    h.updater.stop();
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [path.join(sandbox, PENDING_DIR, '1.9.0', h.fx.name)]);
  });

  it('a check already running when Restart is chosen is stopped, and its answer changes nothing', async () => {
    const h = await readyWithHeldChecks();
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.held.length === 1, 'the scheduled lookup');
    assert.equal(h.updater.state().status, 'ready');
    assert.equal(await h.updater.prepareInstall(), true);
    h.answer(); // 1.9.1 is out — but this check was stopped
    await settle();
    await settle();
    assert.ok(!h.github.seen.some((x) => x.url.includes('1.9.1')), 'nothing of the newer release is fetched');
    assert.equal(h.updater.state().status, 'ready');
    h.updater.stop();
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [path.join(sandbox, PENDING_DIR, '1.9.0', h.fx.name)]);
  });

  it('stop() stops a check made while an update is ready, so the update survives to be installed', async () => {
    const h = await readyWithHeldChecks();
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.held.length === 1, 'the scheduled lookup');
    // The shell's shutdown: stop first, then the hand-off a moment later.
    h.updater.stop();
    h.answer();
    await settle();
    await settle();
    assert.ok(!h.github.seen.some((x) => x.url.includes('1.9.1')));
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [path.join(sandbox, PENDING_DIR, '1.9.0', h.fx.name)]);
  });

  it('a check the restart stopped is due again at once when the restart does not go ahead', async () => {
    const h = await readyWithHeldChecks();
    // Check for updates, an hour after the last check: not yet due on the clock.
    h.advance(RETRY_INTERVAL_MS);
    h.updater.checkNow();
    await until(() => h.held.length === 1, 'the manual lookup');
    assert.equal(await h.updater.prepareInstall(), true, 'the lookup is stopped');
    h.updater.abandonInstall();
    h.tick().fn();
    await until(() => h.lookups() === 3, 'the stopped check, run at the next tick rather than in five hours');
    h.answer();
  });

  it('a restart that does not go ahead lets the clock check again', async () => {
    const h = await readyWithHeldChecks();
    assert.equal(await h.updater.prepareInstall(), true);
    h.updater.abandonInstall(); // drafts would not save; nothing is staged on Windows
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.lookups() === 2, 'the next scheduled check');
  });
});

describe('a newer release while an update is ready', () => {
  /* One folder per version: 1.9.0 stays ready, offered and installable while
     1.9.1 downloads beside it, until 1.9.1 has verified (QA, 2026-10-10,
     TT-3485). */
  const pending = (...parts) => path.join(sandbox, PENDING_DIR, ...parts);
  const installer = (version) => updateAssetName(version, 'win32', 'x64');

  /** Point the fake GitHub at another release, as publishing one would. */
  function publish(fx, next) {
    fx.release = next.release;
    fx.files = next.files;
    fx.version = next.version;
  }

  /** A Windows updater with 1.9.0 ready, a clock the test moves, and 1.9.1 about to be published. */
  async function readyWindows(overrides = {}) {
    let now = 1_000_000;
    const fx = fixture('1.9.0');
    const h = windowsUpdater(fx, { ...overrides, deps: { now: () => now, ...overrides.deps } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the first download');
    const tick = () => h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000);
    return {
      ...h, fx, tick,
      advance: (ms) => { now += ms; },
      lookups: () => h.github.seen.filter((x) => x.url === RELEASE_API).length,
      asked: (version) => h.github.seen.some((x) => x.url === download(version, installer(version))),
    };
  }

  /** Everything the person can see or do names 1.9.0, and Restart installs 1.9.0. */
  async function stillOffers190(h, what) {
    const state = h.updater.state();
    assert.equal(state.status, 'ready', what);
    assert.equal(state.latestVersion, '1.9.0', what);
    assert.equal(state.releaseUrl, `${REPOSITORY}/releases/tag/v1.9.0`, what);
    assert.equal(state.notes, 'Fixes.', what);
    assert.equal(state.banner, '1.9.0', what);
    assert.equal(state.error, '', what);
    assert.ok(fs.existsSync(pending('1.9.0', installer('1.9.0'))), what);
  }

  async function installs190(h) {
    assert.equal(await h.updater.prepareInstall(), true);
    h.updater.stop();
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [pending('1.9.0', installer('1.9.0'))]);
  }

  it('replaces the ready update only once the newer one has verified, and that one is ready at the next launch with no network', async () => {
    const h = await readyWindows();
    let checked = false;
    const newer = fixture('1.9.1');
    publish(h.fx, newer);
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.asked('1.9.1'), 'the newer download');
    assert.equal(h.updater.state().latestVersion, '1.9.0', 'while it downloads, the screen still describes 1.9.0');
    assert.ok(!h.states.some((x) => x.status === 'downloading' && x.latestVersion === '1.9.1'), 'quietly: no downloading status over a ready update');
    await until(() => h.updater.state().latestVersion === '1.9.1', 'the replacement');
    checked = true;
    const state = h.updater.state();
    assert.equal(state.status, 'ready');
    assert.equal(state.banner, '1.9.1');
    assert.equal(state.releaseUrl, `${REPOSITORY}/releases/tag/v1.9.1`);
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.1'], 'the replaced 1.9.0 is gone');
    assert.deepEqual(fs.readdirSync(pending('1.9.1')).sort(), ['Zelos-1.9.1-setup-x64.exe', 'release-notes.json', 'release.json', 'release.json.sig']);
    h.updater.stop();

    const again = windowsUpdater(h.fx);
    const restored = await again.updater.start();
    assert.ok(checked);
    assert.equal(restored.status, 'ready');
    assert.equal(restored.latestVersion, '1.9.1');
    assert.equal(again.github.seen.length, 0, 'nothing is fetched to know that');
    assert.equal(await again.updater.prepareInstall(), true);
    assert.equal(again.updater.install(), true);
    assert.deepEqual(again.launched, [pending('1.9.1', installer('1.9.1'))]);
  });

  it('a newer release whose bytes differ from the signed hash leaves 1.9.0 ready everywhere, and is tried again in an hour', async () => {
    const tampered = Buffer.from(fixture('1.9.1').payload);
    const h = await readyWindows({ github: { override: { [storage(installer('1.9.1'))]: async () => new Response(tampered) } } });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.asked('1.9.1') && !fs.existsSync(pending('1.9.1')), 'the refused newer download');
    await settle();
    await stillOffers190(h, 'after the refusal');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.0'], 'only the refused folder is removed');
    assert.equal(h.updater.skipBanner().banner, '');
    assert.equal(readUpdateSettings(path.join(sandbox, 'updates.json')).skipped, '1.9.0', 'Skip this version skips the version the banner named');
    const lookups = h.lookups();
    h.advance(RETRY_INTERVAL_MS - 1);
    h.tick().fn();
    await settle();
    assert.equal(h.lookups(), lookups, 'not again within the hour');
    h.advance(1);
    h.tick().fn();
    await until(() => h.lookups() === lookups + 1, 'the retry');
    await until(() => !h.updater.state().progress && !fs.existsSync(pending('1.9.1')), 'the second refusal');
    await settle();
    await installs190(h);
  });

  it('a newer installer Authenticode does not accept leaves 1.9.0 ready and installable', async () => {
    const h = await readyWindows({
      publisher: PUBLISHER,
      signature: (file) => (file.includes('1.9.1') ? { status: 'Valid', publisher: 'Someone Else Ltd' } : { status: 'Valid', publisher: PUBLISHER }),
    });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.signatures.some((f) => f.includes('1.9.1')) && !fs.existsSync(pending('1.9.1')), 'the refused signature');
    await settle();
    await stillOffers190(h, 'after the Authenticode refusal');
    await installs190(h);
  });

  /** 1.9.1's installer request hangs until it is stopped. */
  function hungNewer() {
    let requested = false;
    let aborted = false;
    const override = { [storage(installer('1.9.1'))]: (_url, { signal }) => new Promise((_resolve, reject) => {
      requested = true;
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }) };
    return { override, requested: () => requested, aborted: () => aborted };
  }

  it('Restart while the newer one downloads installs 1.9.0, stops the download, and a restart that does not go ahead resumes it at once', async () => {
    const hung = hungNewer();
    const h = await readyWindows({ github: { override: hung.override } });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(hung.requested, 'the newer download');
    await stillOffers190(h, 'mid-download');
    assert.equal(h.updater.snoozeBanner().banner, '', 'Remind me later puts off 1.9.0');
    assert.equal(await h.updater.prepareInstall(), true);
    await until(hung.aborted, 'the newer download to stop');
    await until(() => !fs.existsSync(pending('1.9.1')), 'its folder to go');
    assert.equal(h.updater.state().latestVersion, '1.9.0');

    // Drafts would not save: the restart is off, and the download it stopped is due now, not in six hours.
    h.updater.abandonInstall();
    const lookups = h.lookups();
    h.tick().fn();
    await until(() => h.lookups() === lookups + 1, 'the resumed check');
    await until(() => h.github.seen.filter((x) => x.url === storage(installer('1.9.1'))).length === 2, 'the newer download again');
    await installs190(h);
  });

  it('turning automatic updates off mid-download stops it and keeps 1.9.0 ready', async () => {
    const hung = hungNewer();
    const h = await readyWindows({ github: { override: hung.override } });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(hung.requested, 'the newer download');
    assert.equal(h.updater.setAuto(false).status, 'ready');
    await until(hung.aborted, 'the download to stop');
    await until(() => !fs.existsSync(pending('1.9.1')), 'its folder to go');
    await stillOffers190(h, 'after turning updates off');
    await installs190(h);
  });

  it('stop() mid-download stops it and leaves the ready update for the installer', async () => {
    const hung = hungNewer();
    const h = await readyWindows({ github: { override: hung.override } });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(hung.requested, 'the newer download');
    assert.equal(await h.updater.prepareInstall(), true);
    h.updater.stop();
    await until(hung.aborted, 'the download to stop');
    await until(() => !fs.existsSync(pending('1.9.1')), 'its folder to go');
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [pending('1.9.0', installer('1.9.0'))]);
  });

  it('a download of a version stopped mid-check is waited for, so its clean-up cannot delete the next download of it', async () => {
    let release = null;
    let calls = 0;
    const h = await readyWindows({
      publisher: PUBLISHER,
      // The first check of 1.9.1's installer hangs until the test lets it go.
      duringVerify: (file) => (file.includes('1.9.1') && ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : undefined),
    });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => release, 'the first Authenticode check');
    h.updater.setAuto(false); // stops it; it unwinds only once Authenticode answers
    h.updater.setAuto(true);
    await h.updater.checkNow();
    await settle();
    release();
    await until(() => h.updater.state().latestVersion === '1.9.1', 'the second download');
    assert.ok(fs.existsSync(pending('1.9.1', installer('1.9.1'))), 'the new file survived the old clean-up');
    assert.equal(await h.updater.prepareInstall(), true);
  });

  it('Check for updates with updates on shows the newer download it starts', async () => {
    const h = await readyWindows();
    publish(h.fx, fixture('1.9.1'));
    const before = h.states.length;
    await h.updater.checkNow();
    await until(() => h.updater.state().latestVersion === '1.9.1', 'the download the check started');
    assert.ok(h.states.slice(before).some((x) => x.status === 'ready' && x.newer?.version === '1.9.1' && Number.isFinite(x.progress)),
      'someone pressed the button: the download is shown, beside the ready 1.9.0');
  });

  it('turning updates off stops a quiet newer download and offers it instead; turning them on takes the offer down while it downloads', async () => {
    const hung = hungNewer();
    const h = await readyWindows({ github: { override: hung.override } });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(hung.requested, 'the quiet download');
    assert.equal(h.updater.state().newer, null, 'nothing offered while Zelos fetches it itself');
    const off = h.updater.setAuto(false);
    assert.equal(off.status, 'ready');
    assert.deepEqual(off.newer, { version: '1.9.1', releaseUrl: `${REPOSITORY}/releases/tag/v1.9.1` }, 'offered at once, not after the next check');
    await until(() => !fs.existsSync(pending('1.9.1')), 'the stopped download to clean up');

    // Back on: the clock fetches it quietly, and the Download button that would do nothing goes.
    h.updater.setAuto(true);
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => h.github.seen.filter((x) => x.url === storage(installer('1.9.1'))).length === 2, 'the quiet download again');
    assert.equal(h.updater.state().newer, null);
  });

  it('stop() while a newer download is in its Authenticode check leaves the prepared update untouched for the installer', async () => {
    let release = null;
    const h = await readyWindows({
      publisher: PUBLISHER,
      duringVerify: (file) => (file.includes('1.9.1') ? new Promise((resolve) => { release = resolve; }) : undefined),
    });
    publish(h.fx, fixture('1.9.1'));
    h.advance(CHECK_INTERVAL_MS);
    h.tick().fn();
    await until(() => release, 'the newer download\'s Authenticode check');
    const before = fs.readdirSync(pending('1.9.0')).sort();
    assert.equal(await h.updater.prepareInstall(), true);
    h.updater.stop();
    release();
    await until(() => !fs.existsSync(pending('1.9.1')), 'the stopped download to clean up');
    assert.deepEqual(fs.readdirSync(pending('1.9.0')).sort(), before, 'the ready folder is untouched');
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [pending('1.9.0', installer('1.9.0'))]);
  });

  it('a release pulled back to an older version drops the ready one before anything else is verified', async () => {
    // Ready at 1.9.1; GitHub's latest becomes 1.9.0 again.
    let now = 1_000_000;
    const fx = fixture('1.9.1');
    const h = windowsUpdater(fx, { deps: { now: () => now } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    publish(fx, fixture('1.9.0'));
    now += CHECK_INTERVAL_MS;
    h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000).fn();
    await until(() => !fs.existsSync(pending('1.9.1')), '1.9.1 to be dropped');
    await until(() => h.updater.state().status === 'ready' && h.updater.state().latestVersion === '1.9.0', '1.9.0 instead');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.0']);
  });
});

describe('a newer release beside a ready update, offered or retried', () => {
  /* Automatic updates off: a newer release is offered beside the ready one,
     never in its place, and the person's download of it shows progress.
     Automatic updates on: a newer release that keeps failing is said, not
     retried in silence (QA, 2026-10-10, TT-3485). */
  const pending = (...parts) => path.join(sandbox, PENDING_DIR, ...parts);
  const installer = (version) => updateAssetName(version, 'win32', 'x64');
  function publish(fx, next) {
    fx.release = next.release;
    fx.files = next.files;
    fx.version = next.version;
  }

  async function readyWithAutoOff(overrides) {
    const fx = fixture('1.9.0');
    const h = windowsUpdater(fx, overrides);
    await h.updater.start();
    h.updater.setAuto(false);
    await h.updater.checkNow();
    await h.updater.download();
    await until(() => h.updater.state().status === 'ready', 'the chosen download');
    return { ...h, fx };
  }

  it('with automatic updates off, a check offers the newer release beside the ready one, and Download fetches it with progress', async () => {
    const h = await readyWithAutoOff();
    publish(h.fx, fixture('1.9.1'));
    const state = await h.updater.checkNow();
    assert.equal(state.status, 'ready', 'Restart for 1.9.0 is still offered');
    assert.equal(state.latestVersion, '1.9.0');
    assert.equal(state.banner, '1.9.0');
    assert.deepEqual(state.newer, { version: '1.9.1', releaseUrl: `${REPOSITORY}/releases/tag/v1.9.1` });
    assert.ok(!h.github.seen.some((x) => x.url.includes('/v1.9.1/')), 'nothing of 1.9.1 is fetched until asked');

    const before = h.states.length;
    await h.updater.download();
    await until(() => h.updater.state().latestVersion === '1.9.1', 'the chosen newer download');
    const during = h.states.slice(before);
    assert.ok(during.some((x) => x.status === 'ready' && x.latestVersion === '1.9.0' && x.newer?.version === '1.9.1' && x.progress === 1),
      'its progress is shown while 1.9.0 stays ready');
    assert.ok(during.every((x) => x.status === 'ready'), 'never anything but ready meanwhile');
    const after = h.updater.state();
    assert.equal(after.newer, null);
    assert.equal(after.progress, null);
    assert.equal(after.banner, '1.9.1');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.1']);
  });

  it('Restart during the person\'s own Download stops it quietly, and Download is offered again', async () => {
    let requests = 0;
    const h = await readyWithAutoOff({ github: { override: { [storage(installer('1.9.1'))]: (_url, { signal }) => new Promise((_resolve, reject) => {
      requests += 1;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) } } });
    publish(h.fx, fixture('1.9.1'));
    await h.updater.checkNow();
    await h.updater.download();
    await until(() => requests === 1, 'the chosen download');
    assert.equal(await h.updater.prepareInstall(), true);
    await until(() => !fs.existsSync(pending('1.9.1')), 'the stopped download to clean up');
    const state = h.updater.state();
    assert.equal(state.error, '', 'stopped for the restart, not failed');
    assert.equal(state.progress, null);
    assert.equal(state.newer?.version, '1.9.1');
    h.updater.abandonInstall(); // drafts would not save
    await h.updater.download();
    await until(() => requests === 2, 'Download again');
  });

  it('a release pulled back below the ready one also clears what was said about a newer one', async () => {
    const tampered = Buffer.from(fixture('1.9.1').payload);
    const h = await readyWithAutoOff({ github: { override: { [storage(installer('1.9.1'))]: async () => new Response(tampered) } } });
    publish(h.fx, fixture('1.9.1'));
    await h.updater.checkNow();
    await h.updater.download();
    await until(() => h.updater.state().error, 'the failed download');
    publish(h.fx, fixture('1.8.5'));
    const state = await h.updater.checkNow();
    assert.equal(state.status, 'available');
    assert.equal(state.latestVersion, '1.8.5');
    assert.equal(state.error, '');
  });

  it('a newer download the person asked for that fails says so, and leaves 1.9.0 ready and installable', async () => {
    const tampered = Buffer.from(fixture('1.9.1').payload);
    const h = await readyWithAutoOff({ github: { override: { [storage(installer('1.9.1'))]: async () => new Response(tampered) } } });
    publish(h.fx, fixture('1.9.1'));
    await h.updater.checkNow();
    await h.updater.download();
    await until(() => h.updater.state().error, 'the refusal');
    const state = h.updater.state();
    assert.equal(state.status, 'ready');
    assert.equal(state.latestVersion, '1.9.0');
    assert.match(state.error, /Zelos 1\.9\.1 could not be downloaded\. The downloaded update does not match the signed release/);
    assert.equal(state.progress, null);
    assert.equal(state.newer?.version, '1.9.1', 'still offered, to try again');
    await until(() => !fs.existsSync(pending('1.9.1')), 'the refused folder to go');
    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [pending('1.9.0', installer('1.9.0'))]);
  });

  it('with automatic updates on, a newer release that keeps failing is said after a few tries in a row, and the message goes once it lands', async () => {
    let broken = true;
    const tampered = Buffer.from(fixture('1.9.1').payload);
    let now = 1_000_000;
    const fx = fixture('1.9.0');
    const h = windowsUpdater(fx, {
      deps: { now: () => now },
      github: { override: { [storage(installer('1.9.1'))]: async () => new Response(broken ? tampered : fx.files.get(installer('1.9.1'))) } },
    });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    publish(fx, fixture('1.9.1'));
    const tick = () => h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000);
    let requests = 0;
    const attempts = () => h.github.seen.filter((x) => x.url === storage(installer('1.9.1'))).length;
    for (let attempt = 1; attempt <= QUIET_FAILURES_SHOWN; attempt++) {
      now += CHECK_INTERVAL_MS;
      tick().fn();
      await until(() => attempts() === requests + 1 && !fs.existsSync(pending('1.9.1')), `failure ${attempt}`);
      requests = attempts();
      await settle();
      const state = h.updater.state();
      assert.equal(state.status, 'ready');
      assert.equal(state.latestVersion, '1.9.0');
      if (attempt < QUIET_FAILURES_SHOWN) assert.equal(state.error, '', `quiet after ${attempt}`);
    }
    assert.match(h.updater.state().error, /Zelos 1\.9\.1 has failed to download 3 times in a row, so Zelos 1\.9\.0 is still the update ready to install/);
    assert.equal(h.updater.state().banner, '1.9.0');

    broken = false;
    now += RETRY_INTERVAL_MS;
    tick().fn();
    await until(() => h.updater.state().latestVersion === '1.9.1', 'the fixed release');
    assert.equal(h.updater.state().error, '');
  });
});

describe('the update folder at launch', () => {
  const pending = (...parts) => path.join(sandbox, PENDING_DIR, ...parts);

  /** Leave 1.9.0 and 1.9.1 both complete in the folder, as a crash mid-replacement would. */
  async function bothFolders() {
    const fx = fixture('1.9.0');
    const first = windowsUpdater(fx);
    await first.updater.start();
    await first.updater.checkNow();
    await until(() => first.updater.state().status === 'ready', '1.9.0');
    first.updater.stop();
    const aside = path.join(sandbox, 'aside-1.9.0');
    fs.cpSync(pending('1.9.0'), aside, { recursive: true });
    const newer = fixture('1.9.1');
    const second = windowsUpdater(newer);
    await second.updater.start();
    await second.updater.checkNow();
    await until(() => second.updater.state().latestVersion === '1.9.1', '1.9.1');
    second.updater.stop();
    fs.cpSync(aside, pending('1.9.0'), { recursive: true });
    return { fx, newer };
  }

  it('after a crash with both versions complete, the higher one is ready and the other removed', async () => {
    const { newer } = await bothFolders();
    const h = windowsUpdater(newer);
    assert.equal((await h.updater.start()).latestVersion, '1.9.1');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.1']);
    assert.equal(h.github.seen.length, 0);
  });

  it('after a crash mid-download, the half-written higher folder loses to the complete one', async () => {
    const { newer } = await bothFolders();
    fs.rmSync(pending('1.9.1', 'release.json'));
    fs.writeFileSync(pending('1.9.1', 'Zelos-1.9.1-setup-x64.exe.partial'), 'half');
    const h = windowsUpdater(newer);
    assert.equal((await h.updater.start()).latestVersion, '1.9.0');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.0']);
  });

  it('a folder named as a higher version but holding another version\'s signed files is refused', async () => {
    const { newer } = await bothFolders();
    // A manifest signed with the real key, naming version 1.9.1 but listing
    // a 1.9.5 installer at its true size and hash, in a folder named 1.9.5:
    // everything matches except the version, so only that check can refuse it.
    fs.renameSync(pending('1.9.1'), pending('1.9.5'));
    fs.renameSync(pending('1.9.5', 'Zelos-1.9.1-setup-x64.exe'), pending('1.9.5', 'Zelos-1.9.5-setup-x64.exe'));
    const manifest = Buffer.from(JSON.stringify({ version: '1.9.1', assets: [{ name: 'Zelos-1.9.5-setup-x64.exe', size: newer.payload.length, sha256: newer.sha }] }));
    fs.writeFileSync(pending('1.9.5', 'release.json'), manifest);
    fs.writeFileSync(pending('1.9.5', 'release.json.sig'), signManifest(manifest, KEY.privateKey));
    const h = windowsUpdater(newer);
    assert.equal((await h.updater.start()).latestVersion, '1.9.0');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.0']);
  });

  /** 1.9.0 and 1.9.1 both complete, and Authenticode unable to answer for 1.9.1 the first time it is asked. */
  async function heldAtLaunch(release) {
    await bothFolders();
    let refusedOnce = false;
    const h = windowsUpdater(release, {
      publisher: PUBLISHER,
      duringVerify: (file) => {
        if (file.includes('1.9.1') && !refusedOnce) { refusedOnce = true; throw new Error('PowerShell did not answer'); }
      },
    });
    assert.equal((await h.updater.start()).latestVersion, '1.9.0', 'the one that could be checked is ready');
    assert.ok(fs.existsSync(pending('1.9.1', 'release.json')), 'the one that could not is left in place');
    return h;
  }

  it('a folder the launch could not check is checked again, not downloaded again, when that version is next wanted', async () => {
    const newer = fixture('1.9.1');
    const h = await heldAtLaunch(newer);
    h.timers.fire(FIRST_CHECK_DELAY_MS);
    await until(() => h.updater.state().latestVersion === '1.9.1', '1.9.1 to be adopted');
    assert.ok(!h.github.seen.some((x) => x.url === download('1.9.1', 'Zelos-1.9.1-setup-x64.exe')), 'its installer is not fetched again');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.1']);
    assert.equal(await h.updater.prepareInstall(), true);
  });

  it('a folder that still cannot be checked is replaced by a fresh download, not left to block that version', async () => {
    const newer = fixture('1.9.1');
    await bothFolders();
    // Authenticode cannot answer for the kept 1.9.1 at launch nor when it is
    // next wanted; only the freshly downloaded file gets an answer.
    let unanswered = 2;
    const h = windowsUpdater(newer, {
      publisher: PUBLISHER,
      duringVerify: (file) => {
        if (file.includes('1.9.1') && unanswered > 0) { unanswered -= 1; throw new Error('PowerShell did not answer'); }
      },
    });
    assert.equal((await h.updater.start()).latestVersion, '1.9.0');
    h.timers.fire(FIRST_CHECK_DELAY_MS);
    await until(() => h.updater.state().latestVersion === '1.9.1', '1.9.1 to be downloaded afresh');
    assert.ok(h.github.seen.some((x) => x.url === download('1.9.1', 'Zelos-1.9.1-setup-x64.exe')), 'its installer is fetched again');
    assert.equal(h.updater.state().error, '');
    assert.deepEqual(fs.readdirSync(pending()), ['1.9.1']);
    assert.equal(await h.updater.prepareInstall(), true);
  });

  it('a folder the launch could not check survives the tidying that follows a failed download', async () => {
    const latest = fixture('1.9.2');
    const tampered = Buffer.from(latest.payload);
    tampered[0] ^= 0xff;
    const release = fixture('1.9.1');
    const h = await heldAtLaunch(release);
    // GitHub's latest is 1.9.2, and its installer is not the signed one.
    Object.assign(release, { release: latest.release, files: new Map([...latest.files, ['Zelos-1.9.2-setup-x64.exe', tampered]]), version: '1.9.2' });
    h.timers.fire(FIRST_CHECK_DELAY_MS);
    await until(() => h.github.seen.some((x) => x.url === storage('Zelos-1.9.2-setup-x64.exe')) && !fs.existsSync(pending('1.9.2')), 'the refused 1.9.2');
    await settle();
    assert.equal(h.updater.state().latestVersion, '1.9.0');
    assert.ok(fs.existsSync(pending('1.9.1', 'release.json')), 'the held 1.9.1 is still there');
  });

  it('removes, without following, anything that is not a plain version folder newer than this app', { skip: process.platform === 'win32' }, async () => {
    const { newer } = await bothFolders();
    fs.rmSync(pending('1.9.0'), { recursive: true });
    // The valid 1.9.1 moves outside; only a symlink to it stays in the folder.
    const outside = path.join(sandbox, 'outside-1.9.1');
    fs.renameSync(pending('1.9.1'), outside);
    fs.symlinkSync(outside, pending('1.9.1'));
    fs.symlinkSync(outside, pending('1.9.2'));
    fs.writeFileSync(pending('notes.txt'), 'x');
    fs.mkdirSync(pending('1.9'));
    fs.mkdirSync(pending('../escape'), { recursive: true });
    fs.mkdirSync(pending('1.8.0'));
    fs.writeFileSync(pending('1.9.3'), 'a file, not a folder');
    const h = windowsUpdater(newer);
    const state = await h.updater.start();
    assert.equal(state.status, 'idle', 'a linked folder is never offered');
    assert.equal(fs.existsSync(pending()), false, 'and everything in the folder went');
    assert.ok(fs.existsSync(path.join(outside, 'Zelos-1.9.1-setup-x64.exe')), 'the link was removed, not followed');
    assert.ok(fs.existsSync(path.join(sandbox, 'escape')), 'nothing outside the folder is touched');
  });

  it('deletes the old one-update-at-a-time layout instead of offering it', async () => {
    const fx = fixture('1.9.0');
    const h = windowsUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    h.updater.stop();
    // Laid out as earlier versions of Zelos left it: everything at the top.
    for (const name of fs.readdirSync(pending('1.9.0'))) fs.renameSync(pending('1.9.0', name), pending(name));
    fs.rmdirSync(pending('1.9.0'));
    fs.mkdirSync(pending('staged'));
    fs.writeFileSync(path.join(sandbox, ATTEMPT_FILE + '.keep'), 'beside the folder');
    const again = windowsUpdater(fx);
    assert.equal((await again.updater.start()).status, 'idle', 'the launch check downloads it again a minute later');
    assert.equal(fs.existsSync(pending()), false);
    assert.ok(fs.existsSync(path.join(sandbox, ATTEMPT_FILE + '.keep')), 'files beside the folder are not touched');
  });
});

describe('the Mac updater', () => {
  const macFixture = (apps = { 'Zelos.app': { id: 'app.zelos.desktop', version: '1.9.0' } }) =>
    fixture('1.9.0', { platform: 'darwin', arch: 'arm64', payload: macZip(apps) });

  it('downloads the signed ZIP, unpacks it on restart, and hands a swap to a script that waits for Zelos to exit', async () => {
    const fx = macFixture();
    const h = macUpdater(fx);
    assert.equal((await h.updater.start()).supported, true);
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    assert.ok(h.github.seen.some((s) => s.url === download('1.9.0', 'Zelos-1.9.0-arm64.zip')));
    assert.equal(fs.existsSync(path.join(sandbox, 'userData', PENDING_DIR, 'staged')), false, 'nothing is unpacked until the restart');

    assert.equal(await h.updater.prepareInstall(), true);
    assert.deepEqual(h.extracted, [path.join(sandbox, 'userData', PENDING_DIR, '1.9.0', 'staged')], 'unpacked inside the ready version\'s own folder');
    const beside = `${h.bundlePath}${MAC_NEW_SUFFIX}`;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(beside, 'info.json'), 'utf8')), { id: 'app.zelos.desktop', version: '1.9.0' },
      'the new app is copied beside the old one before Zelos quits');
    assert.equal(fs.existsSync(path.join(sandbox, 'userData', PENDING_DIR, 'staged')), false);
    assert.equal(h.updater.install(), true);
    assert.equal(h.swaps.length, 1);
    const [swap] = h.swaps;
    assert.equal(swap.pid, 4242);
    assert.equal(swap.target, h.bundlePath);
    assert.equal(swap.incoming, beside);
    assert.equal(swap.resultFile, path.join(sandbox, 'userData', RESULT_FILE), 'outside the folder each download empties');
    assert.equal(swap.version, '1.9.0');
    assert.equal(fs.readFileSync(path.join(sandbox, 'userData', ATTEMPT_FILE), 'utf8'), '1.9.0\n');
  });

  it('reports macOS refusing to write beside the app while the board is still open', async () => {
    const h = macUpdater(macFixture(), { copyRefused: true });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    assert.equal(await h.updater.prepareInstall(), false);
    assert.match(h.updater.state().error, /could not write the update next to the app/);
    assert.equal(fs.existsSync(`${h.bundlePath}${MAC_NEW_SUFFIX}`), false);
    assert.equal(h.swaps.length, 0);
  });

  it('waits for other Zelos processes, such as an MCP server, without losing the download', async () => {
    let others = 1;
    const h = macUpdater(macFixture(), { get others() { return others; } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    assert.equal(await h.updater.prepareInstall(), false);
    assert.equal(h.updater.state().status, 'ready', 'the update stays ready');
    assert.match(h.updater.state().error, /Another Zelos process/);
    others = 0;
    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.updater.state().error, '');
    // The restart then does not go ahead (drafts would not save): the copy goes, the update stays.
    h.updater.abandonInstall();
    assert.equal(fs.existsSync(`${h.bundlePath}${MAC_NEW_SUFFIX}`), false);
    assert.equal(h.updater.state().status, 'ready');
    assert.equal(h.updater.install(), false, 'nothing to swap until it is prepared again');
    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.updater.install(), true);
  });

  it('removes a copy beside the app left by a restart that never happened', async () => {
    const h = macUpdater(macFixture());
    fs.mkdirSync(`${h.bundlePath}${MAC_NEW_SUFFIX}`);
    await h.updater.start();
    assert.equal(fs.existsSync(`${h.bundlePath}${MAC_NEW_SUFFIX}`), false);
  });

  for (const [what, apps] of [
    ['another app', { 'Zelos.app': { id: 'com.example.other', version: '1.9.0' } }],
    ['the wrong version', { 'Zelos.app': { id: 'app.zelos.desktop', version: '1.8.0' } }],
    ['no app at all', {}],
    ['two apps', { 'Zelos.app': { id: 'app.zelos.desktop', version: '1.9.0' }, 'Other.app': { id: 'app.zelos.desktop', version: '1.9.0' } }],
  ]) {
    it(`refuses a signed ZIP that unpacks to ${what}`, async () => {
      const h = macUpdater(macFixture(apps));
      await h.updater.start();
      await h.updater.checkNow();
      await until(() => h.updater.state().status === 'ready', 'the download');
      assert.equal(await h.updater.prepareInstall(), false);
      assert.equal(h.updater.state().status, 'error');
      assert.equal(h.updater.install(), false);
      assert.equal(h.swaps.length, 0);
      assert.equal(fs.existsSync(path.join(sandbox, 'userData', PENDING_DIR)), false);
    });
  }

  it('reports a swap the last run could not finish, once, and cleans up after it', async () => {
    const fx = macFixture();
    fs.mkdirSync(path.join(sandbox, 'userData', PENDING_DIR, 'staged'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'userData', ATTEMPT_FILE), '1.9.0\n');
    fs.writeFileSync(path.join(sandbox, 'userData', RESULT_FILE), 'failed move 1.9.0\n');
    const h = macUpdater(fx);
    fs.mkdirSync(`${h.bundlePath}${MAC_NEW_SUFFIX}`);
    const state = await h.updater.start();
    assert.match(state.installProblem, /Zelos 1\.9\.0 could not replace this copy/);
    assert.match(state.installProblem, /App Management/);
    for (const left of [path.join(sandbox, 'userData', RESULT_FILE), path.join(sandbox, 'userData', ATTEMPT_FILE),
      path.join(sandbox, 'userData', PENDING_DIR), `${h.bundlePath}${MAC_NEW_SUFFIX}`]) {
      assert.equal(fs.existsSync(left), false, left);
    }

    // "ok" from the script is not taken on trust: the running version decides.
    fs.writeFileSync(path.join(sandbox, 'userData', RESULT_FILE), 'ok 1.9.0\n');
    assert.match((await macUpdater(fx).updater.start()).installProblem, /could not replace/);
    fs.writeFileSync(path.join(sandbox, 'userData', RESULT_FILE), 'ok 1.9.0\n');
    assert.equal((await macUpdater(fx, { currentVersion: '1.9.0' }).updater.start()).installProblem, '', 'a landed update is not news');
  });

  it('reads the swap result strictly', () => {
    assert.deepEqual(parseSwapResult('ok 1.9.0\n'), { ok: true, step: '', version: '1.9.0' });
    assert.deepEqual(parseSwapResult('failed replace 1.9.0'), { ok: false, step: 'replace', version: '1.9.0' });
    assert.deepEqual(parseSwapResult('failed restore 1.9.0'), { ok: false, step: 'restore', version: '1.9.0' });
    for (const bad of ['', 'ok', 'failed 1.9.0', 'ok 1.9.0; rm -rf /', 'failed other 1.9.0', null]) {
      assert.equal(parseSwapResult(bad), null, String(bad));
    }
  });
});

describe('the macOS swap script', { skip: process.platform === 'win32' }, () => {
  /* The real script, run by /bin/sh against throwaway folders. The pid it
     waits on has already exited, so it proceeds at once, and its reopen step
     is pointed at a recorder so nothing on the machine running the suite opens. */
  function run(setup, { target: targetName = 'Zelos.app', path: searchPath = () => '/bin:/usr/bin' } = {}) {
    const root = fs.mkdtempSync(path.join(sandbox, 'swap-'));
    const target = path.join(root, targetName);
    const incoming = `${target}${MAC_NEW_SUFFIX}`;
    const result = path.join(root, 'result.txt');
    const opened = `${root}-opened.txt`; // outside root, which one test makes read-only
    const script = path.join(root, 'swap.sh');
    const reopen = path.join(root, 'reopen.sh');
    fs.writeFileSync(reopen, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o700 });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'which'), 'old');
    fs.mkdirSync(incoming, { recursive: true });
    fs.writeFileSync(path.join(incoming, 'which'), 'new');
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 });
    setup?.({ root, target, incoming });
    const gone = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString();
    try {
      execFileSync('/bin/sh', [script, gone, target, incoming, result, '1.9.0'], { cwd: root, stdio: 'pipe', env: { PATH: searchPath(root), ZELOS_SWAP_OPEN: reopen } });
    } catch { /* a failed swap exits 1; the result file says which step */ }
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return { root, target, incoming, result: read(result), opened: read(opened).trim().split('\n').filter(Boolean) };
  }

  it('renames the new app into place, removes the old one, records success and reopens', () => {
    const r = run();
    assert.equal(fs.readFileSync(path.join(r.target, 'which'), 'utf8'), 'new');
    assert.equal(fs.existsSync(`${r.target}.zelos-previous`), false);
    assert.equal(fs.existsSync(r.incoming), false);
    assert.equal(r.result, 'ok 1.9.0\n');
    assert.deepEqual(r.opened, [r.target]);
  });

  it('leaves the old app untouched when it cannot be moved aside', () => {
    // A read-only parent stands in for macOS refusing to rename the app.
    const r = run(({ root }) => fs.chmodSync(root, 0o555));
    fs.chmodSync(r.root, 0o755);
    assert.equal(fs.readFileSync(path.join(r.target, 'which'), 'utf8'), 'old');
    assert.equal(r.result, '', 'the result file is in the same unwritable folder in this stand-in');
    assert.deepEqual(r.opened, [r.target]);
  });

  it('puts the old app back when the new one cannot be moved in', () => {
    const r = run(({ incoming }) => fs.rmSync(incoming, { recursive: true }));
    assert.equal(fs.readFileSync(path.join(r.target, 'which'), 'utf8'), 'old');
    assert.equal(r.result, 'failed replace 1.9.0\n');
    assert.deepEqual(r.opened, [r.target]);
  });

  it('when even the restore fails, keeps the old app under a fresh name and never nests it', () => {
    // A stand-in `mv` that refuses both renames back into place, as a full
    // disk or a protected folder might, with an earlier "(previous)" already there.
    const r = run(({ root, incoming }) => {
      fs.rmSync(incoming, { recursive: true });
      fs.mkdirSync(path.join(root, 'Zelos (previous).app'));
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'mv'), `#!/bin/sh\ncase "$2" in */Zelos.app) exit 1;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    }, { path: (root) => `${path.join(root, 'bin')}:/bin:/usr/bin` });
    assert.equal(r.result, 'failed restore 1.9.0\n');
    assert.equal(fs.readFileSync(path.join(r.root, 'Zelos (previous 2).app', 'which'), 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(path.join(r.root, 'Zelos (previous).app')), [], 'the earlier one is left alone');
    assert.deepEqual(r.opened, [path.join(r.root, 'Zelos (previous 2).app')]);
  });

  it('treats every path as data, never as script', () => {
    const r = run(null, { target: 'Zelos $(touch pwned) ; `touch pwned2` ".app' });
    assert.equal(fs.readFileSync(path.join(r.target, 'which'), 'utf8'), 'new');
    assert.equal(r.result, 'ok 1.9.0\n');
    assert.equal(fs.existsSync(path.join(r.root, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(r.root, 'pwned2')), false);
  });
});
