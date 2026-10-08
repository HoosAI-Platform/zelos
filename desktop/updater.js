/**
 * desktop/updater.js — automatic updates for the packaged desktop app.
 *
 * No npm package is involved, and that is the design rather than an accident:
 * an updater runs in the main process with every privilege the app has, and it
 * downloads programs and runs them. The README's zero-dependency promise is
 * about exactly that kind of code, so this is written against what Electron and
 * Node already ship.
 *
 * What it does, per platform:
 *
 *   - macOS: Electron's own `autoUpdater` (Squirrel.Mac, compiled into
 *     Electron). The release's feed file is read and checked here first: it
 *     must name that version and that release's ZIP, at the address this
 *     repository gives it, or Squirrel never sees it. Squirrel is not handed the
 *     feed until the person chooses Restart to update, because once Squirrel has
 *     downloaded an update it installs it the next time the app quits, asked or
 *     not. It then downloads the ZIP and refuses to install it unless its code
 *     signature satisfies the running app's designated requirement — the same
 *     Apple developer identity.
 *
 *   - Windows: the NSIS installer for this machine's architecture is downloaded
 *     here, streamed to disk with a running SHA-256, held to the exact size
 *     GitHub lists, compared with the release's SHA256SUMS.txt, and then checked
 *     with Windows' own `Get-AuthenticodeSignature`: the signature must be Valid
 *     and the signer must be the publisher named in desktop/package.json. The
 *     checksum proves the file arrived intact; the signature is what proves who
 *     made it. Both are checked again when the person chooses Restart to update,
 *     and the checksum once more in the moment before the installer starts.
 *
 * Nothing is installed without the person asking. A downloaded update waits as
 * "ready" until they choose Restart to update, and the restart goes through the
 * shell's normal shutdown (drafts saved, sweep settled, database closed, home
 * lock released) before the installer takes over.
 *
 * An unsigned or ad-hoc-signed build never tries. Updating needs a publisher
 * identity to compare against, so until `updates.windowsPublisher` and
 * `updates.macTeamId` are filled in desktop/package.json — and, on macOS, the
 * running app really is signed by that team — the updater reports why it is off
 * and the manual check in Settings remains the way to update.
 *
 * Everything with an effect outside this module — the network, the clock, the
 * file system, Squirrel, PowerShell, spawning the installer — arrives through
 * `createUpdater`'s arguments, so test/updater.test.mjs can drive every path
 * without Electron, a network or a signed build.
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
const MAX_FEED_BYTES = 16_384;
const MAX_SUMS_BYTES = 65_536;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

/**
 * The hosts a release download may pass through. GitHub answers a release
 * download address with a redirect to its asset storage; anything else in the
 * chain is refused before it is contacted.
 */
export const DOWNLOAD_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

const DOWNLOAD_PREFIX = `${REPOSITORY}/releases/download/`;

/** The name of the folder a Windows installer waits in; see createUpdater. */
export const PENDING_DIR = 'pending-update';

/** Settings → Updates and the menus read these words; keep them plain. */
const UNSUPPORTED = Object.freeze({
  source: 'This copy of Zelos runs from source, so it is updated with git rather than automatically.',
  platform: 'Automatic updates are available in the Mac and Windows apps.',
  arch: 'Automatic updates are not available for this processor.',
  unsigned: 'This build is not signed by the Zelos publisher, so it cannot install updates by itself. Use Check for updates and download new versions from the release page.',
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * `<home>/updates.json` holds one choice: whether to update automatically.
 * Missing, unreadable or malformed means the default, which is on.
 */
export function readUpdateSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { auto: parsed?.auto !== false };
  } catch {
    return { auto: true };
  }
}

export function writeUpdateSettings(file, settings) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ auto: settings.auto === true }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/* ------------------------------------------------------------------ *
 * Release files
 * ------------------------------------------------------------------ */

/** The release files this platform and architecture updates from. */
export function updateAssetNames(version, platform, arch) {
  if (platform === 'darwin') return { feed: `zelos-update-mac-${arch}.json`, zip: `Zelos-${version}-${arch}.zip` };
  if (platform === 'win32') return { installer: `Zelos-${version}-setup-${arch}.exe`, sums: 'SHA256SUMS.txt' };
  return null;
}

/**
 * The Squirrel.Mac feed a release carries for one architecture. Squirrel's
 * `json` server type compares `currentRelease` with the running version and
 * downloads that release's `updateTo.url`. prepare-release.mjs writes it.
 */
export function macFeed({ version, url, publishedAt, notes = '' }) {
  return {
    currentRelease: version,
    releases: [{ version, updateTo: { version, name: `Zelos ${version}`, notes, pub_date: publishedAt, url } }],
  };
}

/**
 * A feed is handed to Squirrel only when it says exactly what the verified
 * release says: this version, and this release's own ZIP at this repository's
 * address. A feed that names any other file — or any other version — is the
 * one thing this check exists to stop reaching Squirrel.
 */
export function checkMacFeed(feed, { version, zipUrl }) {
  if (!feed || typeof feed !== 'object' || feed.currentRelease !== version || !Array.isArray(feed.releases)) return false;
  const entry = feed.releases.find((release) => release?.version === version);
  return entry?.updateTo?.version === version && entry.updateTo.url === zipUrl
    && feed.releases.every((release) => release?.updateTo?.url === zipUrl);
}

/** `<sha256>  <name>` lines, as `sha256sum` and prepare-release.mjs write them. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (match && !sums.has(match[2])) sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * What `Get-AuthenticodeSignature` has to say before an installer is trusted:
 * a Valid signature (intact, and chaining to a root Windows trusts) whose
 * signer's simple name — the name Windows shows as the publisher, read by
 * .NET from the certificate rather than parsed out of a subject string here —
 * is exactly the configured publisher. No thumbprint is pinned: signing
 * services such as Azure Trusted Signing issue short-lived certificates, so a
 * pin would break every update after the next rotation.
 */
export function signatureMatches(signature, publisher) {
  return Boolean(publisher) && signature?.status === 'Valid' && signature.publisher === publisher;
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

/** Read a small release file whole, refusing anything over `maxBytes`. */
/** A Content-Length header as a number, or null when there is none to trust. */
function declaredLength(response) {
  const raw = response.headers.get('content-length');
  return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
}

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
  return Buffer.concat(chunks, total).toString('utf8');
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
 * @param {string} deps.downloadDir        where a Windows installer waits
 * @param {{windowsPublisher?: string, macTeamId?: string}} deps.signing
 * @param {object} [deps.mac]              { autoUpdater, readTeamId: async () => string }
 * @param {object} [deps.windows]          { verifySignature: async (file) => ({status, publisher}), launchInstaller: (file, onError) => void }
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {object} [deps.logger]
 * @param {Function} [deps.onChange]       called with a fresh state() after every change
 */
export function createUpdater({
  currentVersion, platform, arch, isPackaged, settingsFile, downloadDir, signing = {},
  mac = {}, windows = {}, fetchImpl = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, logger = null, onChange = () => {},
}) {
  // The download folder is emptied with a recursive remove before every
  // download, so it must be a folder this module owns and nothing else.
  if (platform === 'win32' && path.basename(String(downloadDir ?? '')) !== PENDING_DIR) {
    throw new Error(`The update download folder must be a dedicated "${PENDING_DIR}" folder.`);
  }
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
  let ready = null;              // Windows: { version, file, sha256 }; macOS: { version, feedUrl }
  let macWaiter = null;          // Restart to update waiting on Squirrel: { resolve, reject }
  let controller = null;
  let tick = null;
  let first = null;
  let stopped = false;
  let installFailed = null;

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

  /* ---------------------------- support ---------------------------- */

  async function decideSupport() {
    if (!isPackaged) return UNSUPPORTED.source;
    if (platform === 'darwin') {
      if (!['arm64', 'x64'].includes(arch)) return UNSUPPORTED.arch;
      if (!signing.macTeamId || typeof mac.readTeamId !== 'function' || !mac.autoUpdater) return UNSUPPORTED.unsigned;
      let team = '';
      try { team = await mac.readTeamId(); } catch { team = ''; }
      return team === signing.macTeamId ? '' : UNSUPPORTED.unsigned;
    }
    if (platform === 'win32') {
      if (!['arm64', 'x64'].includes(arch)) return UNSUPPORTED.arch;
      if (!signing.windowsPublisher || typeof windows.verifySignature !== 'function' || typeof windows.launchInstaller !== 'function') return UNSUPPORTED.unsigned;
      return '';
    }
    return UNSUPPORTED.platform;
  }

  /* ----------------------------- macOS ----------------------------- */

  if (platform === 'darwin' && mac.autoUpdater) {
    const updater = mac.autoUpdater;
    // Squirrel only ever runs on behalf of a Restart to update that is waiting
    // for it; an event with nobody waiting changes nothing.
    updater.on('update-downloaded', () => macWaiter?.resolve());
    updater.on('update-not-available', () => macWaiter?.reject(new Error('The update is no longer available.')));
    updater.on('error', (err) => {
      if (status === 'installing') { installFailed?.(err); return; }
      macWaiter?.reject(new Error(`The update could not be downloaded. ${err?.message ?? ''}`.trim()));
    });
  }

  /**
   * Verify the release's Mac feed and stop there. The ZIP itself is fetched
   * by Squirrel when the person chooses Restart to update (see prepareInstall),
   * because a download Squirrel has finished is installed at the next quit.
   */
  async function downloadMac(version, raw, own) {
    const names = updateAssetNames(version, platform, arch);
    const feed = releaseAsset(raw, version, names.feed);
    const zip = releaseAsset(raw, version, names.zip);
    if (!feed || !zip) throw new Error('This release has no automatic update for this Mac. Download it from the release page.');
    const parsed = await readReleaseFile(feed.url, MAX_FEED_BYTES, own).then(JSON.parse).catch((err) => {
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    if (!checkMacFeed(parsed, { version, zipUrl: zip.url })) throw new Error('The update feed could not be verified.');
    if (stopped || controller !== own) throw new Error('The update check was stopped.');
    ready = { version, feedUrl: feed.url };
    controller = null;
    log('info', 'update verified; Squirrel will download it on restart', { version });
    set({ status: 'ready', error: '', progress: null });
  }

  /**
   * Squirrel's download, started by Restart to update; resolves when it is
   * staged. There is deliberately no deadline: Squirrel cannot be cancelled,
   * and a download it finishes after Zelos stopped waiting would still be
   * installed at the next quit. The person asked for this update, so a slow
   * download is shown as downloading until it lands or Squirrel reports an
   * error, and the restart follows.
   */
  function downloadWithSquirrel() {
    return new Promise((resolve, reject) => {
      macWaiter = {
        resolve: () => { macWaiter = null; resolve(); },
        reject: (err) => { macWaiter = null; reject(err); },
      };
      try {
        mac.autoUpdater.setFeedURL({ url: ready.feedUrl, serverType: 'json' });
        mac.autoUpdater.checkForUpdates();
      } catch (err) {
        macWaiter.reject(err);
      }
    });
  }

  /** A small release file, read whole under its own deadline. */
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

  /* ---------------------------- Windows ---------------------------- */

  /** Empty the download folder; a file Windows still holds open is left for next time. */
  function removeDownloads() {
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch (err) {
      log('warn', 'could not remove an old update download', { error: err.message });
    }
  }

  async function verifyInstaller(file, sha256) {
    if (await sha256File(file) !== sha256) throw new Error('The downloaded update does not match the release checksum.');
    let signature;
    try { signature = await windows.verifySignature(file); } catch { signature = null; }
    if (!signatureMatches(signature, signing.windowsPublisher)) {
      throw new Error('The downloaded update is not signed by the Zelos publisher.');
    }
  }

  async function downloadWindows(version, raw, own) {
    const names = updateAssetNames(version, platform, arch);
    const installer = releaseAsset(raw, version, names.installer);
    const sumsAsset = releaseAsset(raw, version, names.sums);
    if (!installer || !sumsAsset) throw new Error('This release has no installer for this PC. Download it from the release page.');
    const sums = parseChecksums(await readReleaseFile(sumsAsset.url, MAX_SUMS_BYTES, own));
    const expected = sums.get(names.installer);
    if (!expected) throw new Error('The release checksums do not list this installer.');

    // Only one installer is ever kept: whatever an earlier run left is removed
    // before this one is written, so the folder cannot fill with old versions.
    removeDownloads();
    const file = path.join(downloadDir, names.installer);
    set({ status: 'downloading', progress: 0 });
    const digest = await downloadToFile(installer.url, file, {
      fetchImpl, signal: own.signal, expectedSize: installer.size, setTimer, clearTimer,
      onProgress: (fraction) => {
        const rounded = Math.floor(fraction * 100) / 100;
        if (rounded !== progress && controller === own) set({ progress: rounded });
      },
    });
    try {
      if (digest !== expected) throw new Error('The downloaded update does not match the release checksum.');
      await verifyInstaller(file, expected);
      // Turning updates off, or the shell stopping, while the signature was
      // being checked: this download is no longer wanted.
      if (stopped || controller !== own) throw new Error('The update download was stopped.');
    } catch (err) {
      removeDownloads();
      throw err;
    }
    ready = { version, file, sha256: expected };
    controller = null;
    log('info', 'update downloaded and verified', { version });
    set({ status: 'ready', error: '', progress: null });
  }

  /* ----------------------------- checks ---------------------------- */

  const busy = () => ['checking', 'downloading', 'ready', 'installing'].includes(status);

  /**
   * Look for a newer release and, when `download` is true, fetch it. Resolves
   * once the check is answered — a download carries on in the background and
   * reports through onChange.
   */
  async function check({ download }) {
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
    if (!download) {
      controller = null;
      set({ status: 'available', ...release });
      return snapshot();
    }
    set({ status: 'checking', ...release });
    const run = platform === 'darwin' ? downloadMac : downloadWindows;
    run(info.latestVersion, raw, own).catch((err) => { if (controller === own) fail(err); });
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
      settings = { auto };
      try {
        writeUpdateSettings(settingsFile, settings);
      } catch (err) {
        log('warn', 'could not save the update setting', { error: err.message });
      }
      // Turning updates off stops a download in progress; one that is already
      // verified and waiting stays ready, because the person can still choose it.
      // A Mac restart the person already chose cannot be called back: Squirrel
      // is downloading on its behalf and will finish whatever this switch says.
      if (!auto && !macWaiter && (status === 'downloading' || status === 'checking')) {
        controller?.abort();
        controller = null;
        if (platform === 'win32') removeDownloads();
        status = 'idle';
        progress = null;
      }
      changed();
      return snapshot();
    },

    /**
     * Re-check a ready update immediately before shutting down for it, while
     * there is still a window to explain a failure in. Resolves true when the
     * restart may go ahead.
     */
    async prepareInstall() {
      if (status !== 'ready' || !ready || macWaiter) return false;
      try {
        if (platform === 'win32') {
          await verifyInstaller(ready.file, ready.sha256);
        } else {
          // Squirrel downloads and checks the signature now, with the board
          // still open; the panel shows the download while it runs. A second
          // Restart (the first was cancelled to keep unsaved drafts) goes
          // straight on: Squirrel already holds the update.
          if (!ready.staged) {
            set({ status: 'downloading', progress: null });
            await downloadWithSquirrel();
            ready.staged = true;
            set({ status: 'ready' });
          }
        }
      } catch (err) {
        ready = null;
        if (platform === 'win32') removeDownloads();
        fail(err);
        return false;
      }
      return true;
    },

    /**
     * Hand the exit to the installer. Called by the shell after the core has
     * stopped. Returns true when the installer has taken over; `onFailure`
     * runs if it then gives up, so the shell can still exit cleanly.
     */
    install({ onFailure = () => {} } = {}) {
      if (status !== 'ready' || !ready) return false;
      set({ status: 'installing' });
      installFailed = (err) => {
        installFailed = null;
        log('error', 'the update could not be installed', { error: err?.message });
        onFailure(err);
      };
      try {
        if (platform === 'darwin') {
          mac.autoUpdater.quitAndInstall();
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
 * The Apple team that signed the running app, read from `codesign`. An ad-hoc
 * signature has no team, which reads as '' and keeps the updater off.
 */
export function macTeamIdReader({ execFile, bundlePath }) {
  return () => new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundlePath], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) { resolve(''); return; }
      const match = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(`${stdout}\n${stderr}`);
      resolve(match ? match[1] : '');
    });
  });
}
