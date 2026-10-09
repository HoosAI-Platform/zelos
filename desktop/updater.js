/**
 * desktop/updater.js — automatic updates for the packaged desktop app.
 *
 * No npm package is involved, and that is the design rather than an accident:
 * an updater runs in the main process with every privilege the app has, and it
 * downloads programs and runs them. The README's zero-dependency promise is
 * about exactly that kind of code, so this is written against what Node and the
 * operating system already ship.
 *
 * Trust comes from the Zelos update key, not from GitHub. Each release carries
 * `release.json` — its version and the size and SHA-256 of every file — and
 * `release.json.sig`, an Ed25519 signature over those exact bytes made in CI
 * with a private key only the publisher holds (scripts/generate-update-key.mjs).
 * The app carries the matching public keys in desktop/package.json. A release
 * whose manifest does not verify against one of them, names another version,
 * or does not list this computer's file at the size GitHub reports is refused
 * before anything large is downloaded; a download whose SHA-256 differs from
 * the signed one is deleted. Someone who could change the GitHub release but
 * does not hold the key cannot get code onto anybody's machine through here.
 *
 * What it does, per platform:
 *
 *   - Windows: the NSIS installer for this machine's architecture is streamed
 *     to disk and checked as above. If the build also names a Windows publisher
 *     (`updates.windowsPublisher`, once a code-signing certificate exists),
 *     Windows' own `Get-AuthenticodeSignature` must agree too. On Restart to
 *     update it runs silently and relaunches Zelos.
 *
 *   - macOS: the app's ZIP is downloaded and checked as above. On Restart to
 *     update it is unpacked with the system's `ditto`, and the result must be
 *     an app with this app's bundle identifier and the new version. After Zelos
 *     has quit, a short shell script swaps it in place of the running bundle,
 *     keeping the old one until the new one is in place (and putting it back if
 *     the move fails), then reopens Zelos. The script writes what happened to a
 *     file the next launch reads, so a swap macOS refused is reported rather
 *     than silently lost.
 *
 * Nothing is installed without the person asking. A downloaded update waits as
 * "ready" until they choose Restart to update, and the restart goes through the
 * shell's normal shutdown (drafts saved, sweep settled, database closed, home
 * lock released) before the installer or the swap takes over.
 *
 * A build with no update key never tries; the manual check in Settings remains
 * the way to update it, and the panel says why.
 *
 * Everything with an effect outside this module — the network, the clock, the
 * file system, `ditto`, PowerShell, spawning the installer or the swap — arrives
 * through `createUpdater`'s arguments, so test/updater.test.mjs can drive every
 * path without Electron, a network or a real release.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { describeRelease, fetchLatestRelease, releaseAsset, REPOSITORY } from '../core/updates.mjs';

/** How often a running Zelos looks for a new release. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After a failed attempt, try again sooner than a full interval — but not in a loop. */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;
/** The launch check waits so it never competes with the board's first load. */
export const FIRST_CHECK_DELAY_MS = 60 * 1000;
/** The clock is consulted this often, so a laptop that slept past a check catches up. */
export const TICK_MS = 15 * 60 * 1000;

const METADATA_TIMEOUT_MS = 20_000;
/** A download that receives nothing for this long is abandoned, however large. */
const STALL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 65_536;
const MAX_SIGNATURE_BYTES = 1_024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

/**
 * The hosts a release download may pass through. GitHub answers a release
 * download address with a redirect to its asset storage; anything else in the
 * chain is refused before it is contacted.
 */
export const DOWNLOAD_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

const DOWNLOAD_PREFIX = `${REPOSITORY}/releases/download/`;

/** The name of the folder a downloaded update waits in; see createUpdater. */
export const PENDING_DIR = 'pending-update';
/** Beside PENDING_DIR: what the macOS swap script reports to the next launch. */
export const RESULT_FILE = 'update-result.txt';
/** Beside PENDING_DIR: the version a restart was about to install, for the next launch to compare. */
export const ATTEMPT_FILE = 'update-attempt.txt';
/** Beside the installed app on macOS: the verified new copy, waiting to be renamed into place. */
export const MAC_NEW_SUFFIX = '.zelos-new';

/** The signed manifest and its signature, as every release names them. */
export const MANIFEST_NAME = 'release.json';
export const SIGNATURE_NAME = 'release.json.sig';

/** Settings → Updates and the menus read these words; keep them plain. */
const UNSUPPORTED = Object.freeze({
  source: 'This copy of Zelos runs from source, so it is updated with git rather than automatically.',
  platform: 'Automatic updates are available in the Mac and Windows apps.',
  arch: 'Automatic updates are not available for this processor.',
  unsigned: 'This build has no Zelos update key, so it cannot install updates by itself. Use Check for updates and download new versions from the release page.',
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * `<home>/updates.json` holds two choices: whether to update automatically
 * (missing, unreadable or malformed means the default, which is on), and the
 * one version whose "ready to install" banner the person chose to skip.
 */
export function readUpdateSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { auto: parsed?.auto !== false, skipped: VERSION.test(parsed?.skipped ?? '') ? parsed.skipped : '' };
  } catch {
    return { auto: true, skipped: '' };
  }
}

export function writeUpdateSettings(file, settings) {
  const temp = `${file}.${process.pid}.tmp`;
  const saved = { auto: settings.auto === true, ...(VERSION.test(settings.skipped ?? '') ? { skipped: settings.skipped } : {}) };
  fs.writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/* ------------------------------------------------------------------ *
 * The signed release manifest
 * ------------------------------------------------------------------ */

/** The release file this platform and architecture updates from. */
export function updateAssetName(version, platform, arch) {
  if (platform === 'darwin') return `Zelos-${version}-${arch}.zip`;
  if (platform === 'win32') return `Zelos-${version}-setup-${arch}.exe`;
  return null;
}

/* Ed25519 arithmetic, only as much as it takes to refuse a weak key. */
const P = 2n ** 255n - 19n;
const mod = (n) => ((n % P) + P) % P;
const power = (base, exp) => {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
};
const inverse = (n) => power(n, P - 2n);
const CURVE_D = mod(-121665n * inverse(121666n));
const SQRT_M1 = power(2n, (P - 1n) / 4n);

/**
 * Whether 32 bytes are a public key a signature can mean anything against: a
 * canonical encoding of a curve point that is not of small order. A
 * small-order key — the identity, the all-zero bytes, a handful of others —
 * lets anyone produce a signature it accepts, and OpenSSL's verify does not
 * refuse one. So a key is decoded here and its multiple by the cofactor (8)
 * computed; a key whose multiple is the identity is no key.
 */
export function isStrongPublicKey(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return false;
  const sign = bytes[31] >> 7;
  const yBytes = Buffer.from(bytes);
  yBytes[31] &= 0x7f;
  const y = BigInt(`0x${Buffer.from(yBytes).reverse().toString('hex')}`);
  if (y >= P) return false; // non-canonical
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(CURVE_D * y2 + 1n);
  let x = mod(u * power(v, 3n) * power(u * power(v, 7n), (P - 5n) / 8n));
  if (mod(v * x * x) !== u) {
    x = mod(x * SQRT_M1);
    if (mod(v * x * x) !== u) return false; // not on the curve
  }
  if (x === 0n && sign === 1) return false;
  if (Number(x & 1n) !== sign) x = mod(-x);
  // Three doublings: 8·(x, y). Twisted Edwards, a = -1, complete formulas.
  let px = x, py = y;
  for (let i = 0; i < 3; i++) {
    const xy = mod(px * py), xx = mod(px * px), yy = mod(py * py), dxxyy = mod(CURVE_D * xx * yy);
    [px, py] = [mod(2n * xy * inverse(mod(1n + dxxyy))), mod((yy + xx) * inverse(mod(1n - dxxyy)))];
  }
  return !(px === 0n && py === 1n);
}

/**
 * An Ed25519 public key from the form desktop/package.json carries it in: the
 * 32-byte key as unpadded base64url (a JWK's `x`). Anything else — including a
 * weak key, see isStrongPublicKey — is no key.
 */
export function publicKeyFrom(x) {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  if (!isStrongPublicKey(Buffer.from(x, 'base64url'))) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  } catch {
    return null;
  }
}

/** What CI writes to release.json.sig: the signature over the manifest's exact bytes, base64. */
export function signManifest(bytes, privateKey) {
  return `${crypto.sign(null, bytes, privateKey).toString('base64')}\n`;
}

/**
 * The manifest, only when its signature verifies against one of `publicKeys`
 * and it names `version`. Several keys may be configured so a new key can be
 * introduced a release before the old one stops signing.
 */
export function verifyReleaseManifest(bytes, signatureText, publicKeys, { version }) {
  const encoded = String(signatureText ?? '').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new Error('The release signature could not be read.');
  const signature = Buffer.from(encoded, 'base64');
  const keys = (Array.isArray(publicKeys) ? publicKeys : []).map(publicKeyFrom).filter(Boolean);
  if (!keys.some((key) => crypto.verify(null, bytes, key, signature))) {
    throw new Error('The release is not signed with the Zelos update key.');
  }
  let manifest;
  try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { manifest = null; }
  if (manifest?.version !== version || !Array.isArray(manifest.assets)) {
    throw new Error('The signed release details do not match this release.');
  }
  return manifest;
}

/** One file's signed size and SHA-256, only when the manifest lists it exactly once and well formed. */
export function manifestAsset(manifest, name) {
  const entries = (Array.isArray(manifest?.assets) ? manifest.assets : []).filter((asset) => asset?.name === name);
  if (entries.length !== 1) return null;
  const { size, sha256 } = entries[0];
  if (!Number.isSafeInteger(size) || size <= 0 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { name, size, sha256 };
}

/**
 * What `Get-AuthenticodeSignature` has to say, when a Windows publisher is
 * configured: a Valid signature (intact, and chaining to a root Windows
 * trusts) whose signer's simple name — read by .NET from the certificate, not
 * parsed from a subject string here — is exactly that publisher. No thumbprint
 * is pinned: signing services issue short-lived certificates.
 */
export function signatureMatches(signature, publisher) {
  return Boolean(publisher) && signature?.status === 'Valid' && signature.publisher === publisher;
}

/** "ok 1.9.0" or "failed <step> 1.9.0", as the swap script writes it. */
export function parseSwapResult(text) {
  const match = /^(ok|failed (wait|move|replace|restore)) (\d+\.\d+\.\d+)\s*$/.exec(String(text ?? ''));
  return match ? { ok: match[1] === 'ok', step: match[2] ?? '', version: match[3] } : null;
}

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

function allowedHop(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
    && DOWNLOAD_HOSTS.includes(parsed.hostname);
}

/**
 * GET a release file, following GitHub's redirects by hand so that every hop
 * is held to DOWNLOAD_HOSTS before it is contacted. The first address must be
 * one of this repository's release downloads. Resolves to the final response;
 * the caller reads (and bounds) the body.
 */
export async function openReleaseDownload(url, { fetchImpl, signal }) {
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX) || !allowedHop(url)) {
    throw new Error('The update download address could not be verified.');
  }
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await fetchImpl(current, { signal, redirect: 'manual', headers: { 'User-Agent': 'Zelos-updater' } });
    } catch {
      if (signal?.aborted) throw new Error('The update download was stopped.');
      throw new Error('Could not reach GitHub to download the update.');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      let next = '';
      if (location) {
        try { next = new URL(location, current).href; } catch { next = ''; }
      }
      if (!allowedHop(next)) throw new Error('The update download was redirected somewhere unexpected.');
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub could not provide the update file. Please try again later.');
    }
    return response;
  }
  throw new Error('The update download was redirected too many times.');
}

/** A Content-Length header as a number, or null when there is none to trust. */
function declaredLength(response) {
  const raw = response.headers.get('content-length');
  return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
}

/** Read a small release file whole, as bytes, refusing anything over `maxBytes`. */
async function readSmall(response, maxBytes) {
  const declared = declaredLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('An update file was larger than expected.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('An update file was larger than expected.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Stream a release file to `file`, hashing as it goes. The size must come out
 * exactly as GitHub listed it; a download that stalls is abandoned. The file is
 * written under a `.partial` name and renamed only when complete, so a crash
 * mid-download never leaves something that looks finished.
 */
export async function downloadToFile(url, file, { fetchImpl, signal, expectedSize, onProgress = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_INSTALLER_BYTES) {
    throw new Error('The update file has an unexpected size.');
  }
  const stall = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  let stallTimer = null;
  const arm = () => {
    clearTimer(stallTimer);
    stallTimer = setTimer(() => stall.abort(), STALL_TIMEOUT_MS);
    stallTimer?.unref?.();
  };
  const partial = `${file}.partial`;
  const hash = crypto.createHash('sha256');
  let handle = null;
  let received = 0;
  try {
    arm();
    const response = await openReleaseDownload(url, { fetchImpl, signal: combined });
    const declared = declaredLength(response);
    if (declared !== null && declared !== expectedSize) {
      await response.body?.cancel().catch(() => {});
      throw new Error('The update file has an unexpected size.');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await fs.promises.open(partial, 'w', 0o600);
    const reader = response.body.getReader();
    try {
      while (true) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > expectedSize) throw new Error('The update file has an unexpected size.');
        hash.update(value);
        await handle.write(value);
        onProgress(received / expectedSize);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (received !== expectedSize) throw new Error('The update download was incomplete.');
    await handle.close();
    handle = null;
    fs.renameSync(partial, file);
    return hash.digest('hex');
  } catch (err) {
    if (stall.signal.aborted && !signal?.aborted) throw new Error('The update download stopped receiving data.');
    if (signal?.aborted) throw new Error('The update download was stopped.');
    throw err;
  } finally {
    clearTimer(stallTimer);
    await handle?.close().catch(() => {});
    fs.rmSync(partial, { force: true });
  }
}

/** The same digest without yielding, in fixed-size chunks rather than one buffer. */
export function sha256FileSync(file) {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}


/* ------------------------------------------------------------------ *
 * The updater
 * ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {string} deps.currentVersion     app.getVersion()
 * @param {string} deps.platform           process.platform
 * @param {string} deps.arch               process.arch
 * @param {boolean} deps.isPackaged        app.isPackaged
 * @param {string} deps.settingsFile       <home>/updates.json
 * @param {string} deps.downloadDir        <userData>/pending-update — emptied freely
 * @param {string[]} deps.publicKeys       the Zelos update keys (base64url Ed25519)
 * @param {string} [deps.windowsPublisher] when set, Authenticode must name this publisher too
 * @param {object} [deps.mac]              { bundlePath, canReplace, extractZip, readBundleInfo, copyApp, otherInstances, launchSwap }
 * @param {object} [deps.windows]          { canReplace, verifySignature, launchInstaller }
 * @param {number} [deps.pid]              this process, for the swap script to wait on
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {object} [deps.logger]
 * @param {Function} [deps.onChange]       called with a fresh state() after every change
 */
export function createUpdater({
  currentVersion, platform, arch, isPackaged, settingsFile, downloadDir, publicKeys = [], windowsPublisher = '',
  mac = {}, windows = {}, pid = process.pid, fetchImpl = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, logger = null, onChange = () => {},
}) {
  // The download folder is emptied with a recursive remove before every
  // download, so it must be a folder this module owns and nothing else.
  if ((platform === 'win32' || platform === 'darwin') && path.basename(String(downloadDir ?? '')) !== PENDING_DIR) {
    throw new Error(`The update download folder must be a dedicated "${PENDING_DIR}" folder.`);
  }
  const resultFile = downloadDir ? path.join(path.dirname(downloadDir), RESULT_FILE) : '';
  const attemptFile = downloadDir ? path.join(path.dirname(downloadDir), ATTEMPT_FILE) : '';
  let settings = readUpdateSettings(settingsFile);
  let supported = null;          // null until start() has decided
  let reason = '';
  let status = 'idle';           // idle | checking | current | available | downloading | ready | installing | error
  let error = '';
  let latestVersion = '';
  let releaseUrl = '';
  let notes = '';
  let progress = null;
  let checkedAt = null;
  let nextAttemptAt = null;
  let ready = null;              // { version, file, sha256, staged? }
  let controller = null;
  let tick = null;
  let first = null;
  let stopped = false;
  let installFailed = null;
  let installProblem = '';       // an update the last restart did not land; kept for the session
  let snoozed = '';              // a version whose banner waits for the next launch; never saved

  const log = (level, message, data) => { try { logger?.[level]?.(`updater: ${message}`, data); } catch { /* logging never breaks updating */ } };

  const snapshot = () => ({
    supported: supported === true,
    reason,
    auto: settings.auto,
    status,
    currentVersion,
    latestVersion,
    releaseUrl,
    notes,
    progress,
    error,
    installProblem,
    // The version the "ready to install" banner offers, or '' for none: a
    // verified update that was neither skipped nor put off until next launch.
    banner: status === 'ready' && latestVersion && latestVersion !== settings.skipped && latestVersion !== snoozed ? latestVersion : '',
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
  });

  const changed = () => {
    try { onChange(snapshot()); } catch (err) { log('warn', 'a state listener failed', { error: err.message }); }
  };

  const set = (patch) => {
    if ('status' in patch) status = patch.status;
    if ('error' in patch) error = patch.error;
    if ('progress' in patch) progress = patch.progress;
    if ('latestVersion' in patch) latestVersion = patch.latestVersion;
    if ('releaseUrl' in patch) releaseUrl = patch.releaseUrl;
    if ('notes' in patch) notes = patch.notes;
    changed();
  };

  const fail = (err) => {
    const message = err?.message || 'The update could not be completed.';
    log('warn', 'update attempt failed', { error: message });
    controller = null;
    nextAttemptAt = now() + RETRY_INTERVAL_MS;
    set({ status: 'error', error: message, progress: null });
  };

  function save() {
    try {
      writeUpdateSettings(settingsFile, settings);
    } catch (err) {
      log('warn', 'could not save the update setting', { error: err.message });
    }
  }

  /** Empty the download folder; a file the system still holds open is left for next time. */
  function removeDownloads() {
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch (err) {
      log('warn', 'could not remove an old update download', { error: err.message });
    }
  }

  /* ---------------------------- support ---------------------------- */

  async function decideSupport() {
    if (!isPackaged) return UNSUPPORTED.source;
    if (platform !== 'darwin' && platform !== 'win32') return UNSUPPORTED.platform;
    if (!['arm64', 'x64'].includes(arch)) return UNSUPPORTED.arch;
    if (!(Array.isArray(publicKeys) && publicKeys.some((key) => publicKeyFrom(key)))) return UNSUPPORTED.unsigned;
    if (platform === 'darwin') {
      if (!mac.bundlePath || ['extractZip', 'readBundleInfo', 'copyApp', 'launchSwap'].some((fn) => typeof mac[fn] !== 'function')) return UNSUPPORTED.unsigned;
      return (typeof mac.canReplace === 'function' && mac.canReplace(mac.bundlePath)) || '';
    }
    if (typeof windows.launchInstaller !== 'function') return UNSUPPORTED.unsigned;
    if (windowsPublisher && typeof windows.verifySignature !== 'function') return UNSUPPORTED.unsigned;
    return (typeof windows.canReplace === 'function' && windows.canReplace()) || '';
  }

  /**
   * Whether the last Restart to update landed. The attempt file names the
   * version that restart was installing; if this launch is not that version,
   * it did not — whatever the installer or swap script said. On macOS the
   * script's own result says which step failed. Either way the person is told
   * for the rest of this session, and the shell shows it once in a dialog.
   */
  function readLastAttempt() {
    const read = (file) => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        fs.rmSync(file, { force: true });
        return text;
      } catch {
        return null;
      }
    };
    const attempted = attemptFile ? read(attemptFile) : null;
    const swap = resultFile ? parseSwapResult(read(resultFile)) : null;
    if (attempted === null && !swap) return;
    removeDownloads();
    const version = /^\d+\.\d+\.\d+$/.test(String(attempted ?? '').trim()) ? attempted.trim() : swap?.version;
    if (!version) return;
    if (version === currentVersion) {
      log('info', 'the update was installed', { version });
      return;
    }
    log('warn', 'the last update did not install', { version, step: swap?.step });
    installProblem = platform === 'darwin'
      ? `Zelos ${version} could not replace this copy of the app, so you are still on ${currentVersion}. Download it from the release page, or allow Zelos in System Settings → Privacy & Security → App Management and try again.`
      : `Zelos ${version} was not installed, so you are still on ${currentVersion}. If Windows asked for permission, the update needs it; otherwise download the installer from the release page.`;
  }

  /**
   * The copy prepareInstall leaves beside the app. No swap can be running when
   * this is called — at start, the single-instance lock means the last one has
   * finished — so a copy found then belongs to a restart that never happened.
   */
  function removeMacCopy() {
    if (platform !== 'darwin' || !mac.bundlePath) return;
    try { fs.rmSync(`${mac.bundlePath}${MAC_NEW_SUFFIX}`, { recursive: true, force: true }); } catch { /* left for next time */ }
  }

  /* ---------------------------- downloads -------------------------- */

  /** A small release file, read whole as bytes under its own deadline. */
  async function readReleaseFile(url, maxBytes, own) {
    const deadline = new AbortController();
    const timer = setTimer(() => deadline.abort(), METADATA_TIMEOUT_MS);
    timer?.unref?.();
    try {
      const response = await openReleaseDownload(url, { fetchImpl, signal: AbortSignal.any([own.signal, deadline.signal]) });
      return await readSmall(response, maxBytes);
    } catch (err) {
      if (deadline.signal.aborted && !own.signal.aborted) throw new Error('GitHub took too long to send an update file.');
      throw err;
    } finally {
      clearTimer(timer);
    }
  }

  async function verifyAuthenticode(file) {
    let signature;
    try { signature = await windows.verifySignature(file); } catch { signature = null; }
    if (!signatureMatches(signature, windowsPublisher)) {
      throw new Error('The downloaded update is not signed by the Zelos publisher.');
    }
  }

  /**
   * Verify the release's signed manifest, then download this computer's file
   * and hold it to the signed size and SHA-256. Nothing large is fetched until
   * the signature has checked out.
   */
  async function download(version, raw, own) {
    const name = updateAssetName(version, platform, arch);
    const asset = releaseAsset(raw, version, name);
    const manifestFile = releaseAsset(raw, version, MANIFEST_NAME);
    const signatureFile = releaseAsset(raw, version, SIGNATURE_NAME);
    if (!asset || !manifestFile || !signatureFile) {
      throw new Error('This release has no automatic update for this computer. Download it from the release page.');
    }
    const manifestBytes = await readReleaseFile(manifestFile.url, MAX_MANIFEST_BYTES, own);
    const signatureBytes = await readReleaseFile(signatureFile.url, MAX_SIGNATURE_BYTES, own);
    const manifest = verifyReleaseManifest(manifestBytes, signatureBytes.toString('latin1'), publicKeys, { version });
    const expected = manifestAsset(manifest, name);
    if (!expected || expected.size !== asset.size) throw new Error('The signed release details do not list this update.');
    if (stopped || controller !== own) throw new Error('The update check was stopped.');

    // Only one update is ever kept: whatever an earlier run left is removed
    // before this one is written, so the folder cannot fill with old versions.
    removeDownloads();
    const file = path.join(downloadDir, name);
    set({ status: 'downloading', progress: 0 });
    const digest = await downloadToFile(asset.url, file, {
      fetchImpl, signal: own.signal, expectedSize: expected.size, setTimer, clearTimer,
      onProgress: (fraction) => {
        const rounded = Math.floor(fraction * 100) / 100;
        if (rounded !== progress && controller === own) set({ progress: rounded });
      },
    });
    try {
      if (digest !== expected.sha256) throw new Error('The downloaded update does not match the signed release.');
      if (platform === 'win32' && windowsPublisher) await verifyAuthenticode(file);
      // Turning updates off, or the shell stopping, while the file was being
      // checked: this download is no longer wanted.
      if (stopped || controller !== own) throw new Error('The update download was stopped.');
    } catch (err) {
      removeDownloads();
      throw err;
    }
    ready = { version, file, sha256: expected.sha256 };
    controller = null;
    log('info', 'update downloaded and verified', { version });
    set({ status: 'ready', error: '', progress: null });
  }

  /** macOS: unpack the verified ZIP and make sure it is this app, at the new version. */
  async function stageMacApp() {
    const staged = path.join(downloadDir, 'staged');
    fs.rmSync(staged, { recursive: true, force: true });
    await mac.extractZip(ready.file, staged);
    const apps = fs.readdirSync(staged).filter((entry) => entry.endsWith('.app'));
    if (apps.length !== 1) throw new Error('The downloaded update does not contain the Zelos app.');
    const app = path.join(staged, apps[0]);
    const [incoming, running] = await Promise.all([mac.readBundleInfo(app), mac.readBundleInfo(mac.bundlePath)]);
    if (!incoming?.id || incoming.id !== running?.id || incoming.version !== ready.version) {
      throw new Error('The downloaded update is not this app at the expected version.');
    }
    // Copied beside the installed app now, while there is a window to report
    // a refusal in. This proves the folder can be written; whether macOS lets
    // the installed app itself be renamed is only known when the swap tries,
    // and a refusal there leaves the old app in place and is reported at the
    // next launch. The copy also makes that swap two renames in one folder.
    const beside = `${mac.bundlePath}${MAC_NEW_SUFFIX}`;
    try {
      fs.rmSync(beside, { recursive: true, force: true });
      await mac.copyApp(app, beside);
    } catch {
      fs.rmSync(beside, { recursive: true, force: true });
      throw new Error('Zelos could not write the update next to the app. Check that your account can change the folder Zelos is in, or download the update from the release page.');
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    return beside;
  }

  /* ----------------------------- checks ---------------------------- */

  const busy = () => ['checking', 'downloading', 'ready', 'installing'].includes(status);

  /**
   * Look for a newer release and, when `download` is true, fetch it. Resolves
   * once the check is answered — a download carries on in the background and
   * reports through onChange.
   */
  async function check({ download: fetchIt }) {
    if (!supported || stopped || busy()) return snapshot();
    controller = new AbortController();
    const own = controller;
    const timer = setTimer(() => own.abort(), METADATA_TIMEOUT_MS);
    timer?.unref?.();
    set({ status: 'checking', error: '', progress: null });
    let raw, info;
    try {
      raw = await fetchLatestRelease({ fetchImpl, signal: own.signal });
      info = describeRelease(raw, currentVersion, new Date(now()).toISOString());
    } catch (err) {
      clearTimer(timer);
      if (controller === own) fail(own.signal.aborted && !stopped ? new Error('The update check timed out.') : err);
      return snapshot();
    }
    clearTimer(timer);
    if (controller !== own) return snapshot();
    checkedAt = now();
    nextAttemptAt = checkedAt + CHECK_INTERVAL_MS;
    const release = { latestVersion: info.latestVersion, releaseUrl: info.releaseUrl, notes: info.notes };
    if (!info.updateAvailable) {
      controller = null;
      set({ status: 'current', ...release });
      return snapshot();
    }
    if (!fetchIt) {
      controller = null;
      set({ status: 'available', ...release });
      return snapshot();
    }
    set({ status: 'checking', ...release });
    download(info.latestVersion, raw, own).catch((err) => { if (controller === own) fail(err); });
    return snapshot();
  }

  function schedule() {
    clearTimer(tick);
    tick = null;
    if (!supported || stopped) return;
    tick = setTimer(() => {
      tick = null;
      if (settings.auto && !busy() && (nextAttemptAt === null || now() >= nextAttemptAt)) {
        check({ download: true }).catch((err) => log('warn', 'scheduled check failed', { error: err.message }));
      }
      schedule();
    }, TICK_MS);
    tick?.unref?.();
  }

  /* ------------------------------ API ------------------------------ */

  return {
    /** Decide whether this build can update itself, then arm the clock. */
    async start() {
      reason = await decideSupport();
      supported = reason === '';
      if (!supported) {
        status = 'idle';
        log('info', 'automatic updates are off for this build', { reason });
        changed();
        return snapshot();
      }
      readLastAttempt();
      removeMacCopy();
      nextAttemptAt = now() + FIRST_CHECK_DELAY_MS;
      first = setTimer(() => {
        first = null;
        if (settings.auto && !busy()) check({ download: true }).catch(() => {});
      }, FIRST_CHECK_DELAY_MS);
      first?.unref?.();
      schedule();
      changed();
      return snapshot();
    },

    state: snapshot,

    /** The person asked: check now, and download if they have automatic updates on. */
    checkNow() {
      return check({ download: settings.auto });
    },

    /** The person asked for the update they were told about. */
    download() {
      if (status !== 'available') return Promise.resolve(snapshot());
      status = 'idle';
      return check({ download: true });
    },

    setAuto(auto) {
      if (typeof auto !== 'boolean') return snapshot();
      settings = { ...settings, auto };
      save();
      // Turning updates off stops a download in progress; one that is already
      // verified and waiting stays ready, because the person can still choose it.
      if (!auto && (status === 'downloading' || status === 'checking')) {
        controller?.abort();
        controller = null;
        removeDownloads();
        status = 'idle';
        progress = null;
      }
      changed();
      return snapshot();
    },

    /**
     * Re-check a ready update, and on macOS unpack it, while there is still a
     * window to explain a failure in. Resolves true when the restart may go
     * ahead.
     */
    async prepareInstall() {
      if (status !== 'ready' || !ready) return false;
      const preparing = ready;
      try {
        if (await sha256File(preparing.file) !== preparing.sha256) throw new Error('The downloaded update changed since it was checked.');
        if (platform === 'win32' && windowsPublisher) await verifyAuthenticode(preparing.file);
        if (platform === 'darwin') {
          // Another Zelos running from this app — usually the MCP server an AI
          // app started — would lose its files mid-flight when the app moves.
          if (typeof mac.otherInstances === 'function' && await mac.otherInstances() > 0) {
            throw Object.assign(new Error('Another Zelos process is running from this app, usually one an AI app started. Quit those apps, then choose Restart to update again.'), { keepDownload: true });
          }
          preparing.staged = await stageMacApp();
        }
      } catch (err) {
        if (err?.keepDownload) {
          // Nothing is wrong with the update; the restart just has to wait.
          set({ error: err.message });
          return false;
        }
        if (ready === preparing) ready = null;
        removeDownloads();
        fail(err);
        return false;
      }
      if (ready === preparing) set({ error: '' });
      return ready === preparing;
    },

    /** "Remind me later": hide the banner until Zelos is next opened. */
    snoozeBanner() {
      if (latestVersion) snoozed = latestVersion;
      changed();
      return snapshot();
    },

    /** "Skip this version": no banner for it again; a newer version still gets one. */
    skipBanner() {
      if (latestVersion) {
        settings = { ...settings, skipped: latestVersion };
        save();
      }
      changed();
      return snapshot();
    },

    /**
     * A prepared restart that is not going ahead after all (a backup began,
     * or drafts would not save): drop the copy beside the app. The download
     * stays ready, so the next Restart to update prepares it again.
     */
    abandonInstall() {
      if (!ready?.staged || status !== 'ready') return;
      ready.staged = undefined;
      removeMacCopy();
    },

    /**
     * Hand the exit to the installer or the swap. Called by the shell after
     * the core has stopped; the shell then quits. Returns true when the hand-off
     * happened; `onFailure` runs if the installer then cannot start.
     */
    install({ onFailure = () => {} } = {}) {
      if (status !== 'ready' || !ready) return false;
      if (platform === 'darwin' && !ready.staged) return false; // not prepared, or abandoned
      set({ status: 'installing' });
      installFailed = (err) => {
        installFailed = null;
        log('error', 'the update could not be installed', { error: err?.message });
        onFailure(err);
      };
      try {
        // Recorded first, so the next launch can tell whether this landed
        // whatever the installer or the swap goes on to do.
        if (attemptFile) fs.writeFileSync(attemptFile, `${ready.version}\n`);
        if (platform === 'darwin') {
          if (!ready.staged || !fs.existsSync(ready.staged)) throw new Error('The update was not unpacked.');
          mac.launchSwap({ pid, target: mac.bundlePath, incoming: ready.staged, resultFile, version: ready.version, dir: downloadDir },
            (err) => installFailed?.(err));
        } else {
          // The checksum once more, in the moment before the installer runs:
          // the file sat in a user-writable folder while drafts were saved and
          // the core stopped. Synchronous on purpose, so nothing runs between
          // this read and the launch.
          if (sha256FileSync(ready.file) !== ready.sha256) throw new Error('The downloaded update changed before it could be installed.');
          windows.launchInstaller(ready.file, (err) => installFailed?.(err));
        }
        log('info', 'installing update', { version: ready.version });
        return true;
      } catch (err) {
        try { fs.rmSync(attemptFile, { force: true }); } catch { /* nothing was attempted */ }
        installFailed?.(err);
        return false;
      }
    },

    stop() {
      stopped = true;
      clearTimer(tick);
      clearTimer(first);
      tick = first = null;
      if (status === 'downloading' || status === 'checking') controller?.abort();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Platform adapters (real effects; not used by the tests)
 * ------------------------------------------------------------------ */

/**
 * `Get-AuthenticodeSignature` through Windows PowerShell, named by its full
 * path so nothing earlier on PATH can stand in for it. The file path reaches
 * the script through the environment, never through the command line, so no
 * file name can become PowerShell syntax.
 */
export function windowsSignatureVerifier({ execFile, systemRoot = process.env.SystemRoot || 'C:\\Windows' }) {
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:ZELOS_UPDATE_FILE; '
    + '$p = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { \'\' }; '
    + '[pscustomobject]@{ status = [string]$s.Status; publisher = [string]$p } | ConvertTo-Json -Compress';
  return (file) => new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ZELOS_UPDATE_FILE: file }, timeout: 30_000, windowsHide: true, maxBuffer: 65_536,
    }, (err, stdout) => {
      if (err) { reject(err); return; }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ status: String(parsed?.status ?? ''), publisher: String(parsed?.publisher ?? '') });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/**
 * Run the NSIS installer silently and let it relaunch Zelos. `--updated` is
 * electron-builder's flag for an in-place update (it reuses the existing
 * install folder); `--force-run` starts the app again after a silent install.
 */
export function windowsInstallerLauncher({ spawn }) {
  return (file, onError) => {
    const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => onError?.(err));
    child.unref();
  };
}

/**
 * Why this Mac's copy of Zelos cannot replace itself, or '' when it can. An
 * app macOS has translocated, or one opened straight from the disk image, is
 * running from a read-only place; one in a folder this account cannot write
 * to cannot be swapped either.
 */
export function macReplaceCheck({ access = fs.accessSync } = {}) {
  return (bundlePath) => {
    if (typeof bundlePath !== 'string' || !bundlePath.endsWith('.app')) return 'Zelos could not find its own app, so it cannot update itself.';
    if (bundlePath.includes('/AppTranslocation/')) {
      return 'macOS is running Zelos from a temporary location. Move Zelos to your Applications folder and open it from there to turn on automatic updates.';
    }
    try {
      access(path.dirname(bundlePath), fs.constants.W_OK);
      access(bundlePath, fs.constants.W_OK);
    } catch {
      return 'Zelos is in a place your account cannot change (or still on the disk image), so it cannot update itself. Move it to your Applications folder and open it from there.';
    }
    return '';
  };
}

/** Unpack a ZIP with the system's `ditto`, which keeps the bundle's symlinks and permissions. */
export function macZipExtractor({ execFile }) {
  return (zip, dest) => new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zip, dest], { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** An app's bundle identifier and short version, read with the system's `plutil`. */
export function macBundleInfoReader({ execFile }) {
  const read = (plist, key) => new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
  return async (app) => {
    const plist = path.join(app, 'Contents', 'Info.plist');
    const [id, version] = await Promise.all([read(plist, 'CFBundleIdentifier'), read(plist, 'CFBundleShortVersionString')]);
    return { id, version };
  };
}

/** Copy an app bundle with the system's `ditto`, which keeps its symlinks, permissions and attributes. */
export function macAppCopier({ execFile }) {
  return (from, to) => new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', [from, to], { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * How many other processes are running this app's executable — the stdio MCP
 * server an AI app spawned, or another account's Zelos. `pgrep -x` matches the
 * executable's name exactly; Electron's helpers are named differently.
 */
export function macOtherInstances({ execFile, executable = process.execPath, pid = process.pid }) {
  return () => new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', path.basename(executable)], { timeout: 15_000 }, (err, stdout) => {
      // pgrep exits 1 when nothing matches; anything else unreadable counts as none.
      const pids = String(stdout ?? '').split(/\s+/).filter((line) => /^\d+$/.test(line) && Number(line) !== pid);
      resolve(err && !pids.length ? 0 : pids.length);
    });
  });
}

/**
 * Why this Windows install cannot update itself, or '' when it can. An
 * installation for all users lives under Program Files, where the silent
 * update would need administrator approval nobody is there to give; and
 * Windows' access check ignores folder permissions, so writing a probe file is
 * the only honest test.
 */
export function windowsReplaceCheck({ installDir = path.dirname(process.execPath), env = process.env, fsImpl = fs } = {}) {
  return () => {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean).map((dir) => path.resolve(dir).toLowerCase());
    const here = path.resolve(installDir).toLowerCase();
    if (programFiles.some((dir) => here === dir || here.startsWith(`${dir}${path.sep}`))) {
      return 'Zelos is installed for all users, so updating it needs an administrator. Download new versions from the release page, or reinstall Zelos for just your account to get automatic updates.';
    }
    const probe = path.join(installDir, `.zelos-update-probe-${process.pid}`);
    try {
      fsImpl.writeFileSync(probe, '');
      fsImpl.rmSync(probe, { force: true });
    } catch {
      return 'Zelos is installed in a folder your account cannot change, so it cannot update itself. Download new versions from the release page.';
    }
    return '';
  };
}

/**
 * The script that swaps the app once Zelos has exited. Constant text: every
 * path and the version reach it as arguments, never as script source. The new
 * copy is already beside the old one (`<app>.zelos-new`, written before Zelos
 * quit), so both moves are renames within one folder. It waits up to two
 * minutes for this process to end, renames the old app aside, renames the new
 * one into its place, and checks each step: a failed rename puts the old app
 * back, and if even that fails it is given a fresh name Finder will open. It records
 * the outcome and reopens Zelos. ZELOS_SWAP_OPEN exists only so the tests can
 * run it without opening anything; the launcher below gives the script a fixed
 * environment, so it is never inherited.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; incoming="$3"; result="$4"; version="$5"
reopen="\${ZELOS_SWAP_OPEN:-/usr/bin/open}"
backup="$target.zelos-previous"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then rm -rf "$incoming"; printf 'failed wait %s\\n' "$version" > "$result"; exit 1; fi
  sleep 0.1
done
rm -rf "$backup"
if ! mv "$target" "$backup"; then
  rm -rf "$incoming"
  printf 'failed move %s\\n' "$version" > "$result"
  "$reopen" "$target"
  exit 1
fi
if mv "$incoming" "$target"; then
  rm -rf "$backup"
  printf 'ok %s\\n' "$version" > "$result"
elif [ ! -e "$target" ] && mv "$backup" "$target"; then
  rm -rf "$incoming"
  printf 'failed replace %s\\n' "$version" > "$result"
else
  previous="\${target%.app} (previous).app"
  n=1
  while [ -e "$previous" ]; do n=$((n + 1)); previous="\${target%.app} (previous $n).app"; done
  if mv "$backup" "$previous"; then
    "$reopen" "$previous"
  fi
  printf 'failed restore %s\\n' "$version" > "$result"
  exit 1
fi
"$reopen" "$target"
`;

export function macSwapLauncher({ spawn }) {
  return ({ pid, target, incoming, resultFile, version, dir }, onError) => {
    const script = path.join(dir, 'swap.sh');
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 });
    const child = spawn('/bin/sh', [script, String(pid), target, incoming, resultFile, version], {
      detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    child.on('error', (err) => onError?.(err));
    child.unref();
  };
}
