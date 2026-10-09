/**
 * test/release.test.mjs — the promises a release build leans on.
 *
 * Cutting a release spans files nothing at runtime ever compares. The checks
 * here are cheap and textual, and each exists because the seam it pins could
 * otherwise only go red at the far end of a 40-minute two-OS CI build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the root and desktop manifests carry the same version', () => {
  /* The release pipeline reads both, and never side by side: the staging
     script derives the artifact names it expects from the root package.json,
     while electron-builder stamps `${version}` from desktop/package.json into
     the names it actually writes. Both fields are edited by hand, so a
     one-sided bump builds installers named for the old version — and the
     mismatch surfaces only after both runners have finished. This is the one
     place the two fields meet before any CI minutes are spent. */
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  assert.equal(desktop.version, root.version,
    'package.json and desktop/package.json disagree on the version — a release bump edits both');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package-lock.json'), 'utf8'));
  assert.equal(lock.version, root.version);
  assert.equal(lock.packages[''].version, root.version);
});

test('the website ships the current UI and versioned download routes together', () => {
  execFileSync(process.execPath, ['scripts/build-website.mjs'], { cwd: ROOT, stdio: 'pipe' });
  const output = path.join(ROOT, '.site-dist');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const source of walk(path.join(ROOT, 'ui'))) {
    const relative = path.relative(path.join(ROOT, 'ui'), source);
    if (relative === 'index.html' || relative === path.join('lib', 'api.js')) continue;
    assert.equal(fs.readFileSync(path.join(output, 'demo', relative), 'utf8'), fs.readFileSync(source, 'utf8'), relative);
  }
  const data = fs.readFileSync(path.join(output, 'demo/lib/demo-data.js'), 'utf8');
  assert.equal(JSON.parse(data.replace(/^export default /, '').replace(/;\s*$/, '')).version, version);
  assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), new RegExp(`Version ${version.replaceAll('.', '\\.')}`));
  const redirects = fs.readFileSync(path.join(output, '_redirects'), 'utf8').trim().split('\n');
  for (const alias of ['Zelos-mac-apple-silicon.dmg', 'Zelos-mac-intel.dmg', 'Zelos-windows-x64.exe', 'Zelos-windows-arm64.exe', 'zelos-source.zip']) {
    const route = redirects.find((line) => line.startsWith(`/downloads/${alias} `));
    assert.ok(route, `Missing download alias ${alias}`);
    assert.ok(route.includes(`/releases/download/v${version}/`), `Stale download ${route}`);
  }
  assert.ok(!fs.readFileSync(path.join(output, 'demo/lib/api.js'), 'utf8').includes("const TOKEN_KEY = 'zelos.token'"), 'The demo must use its in-memory adapter');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'release.json'), 'utf8')).version, version);
});

test('CI installs the shell\'s build tools from the lockfile, with no fallback', () => {
  /* desktop/.gitignore keeps package-lock.json tracked on purpose: an app
     that asks people to trust an unsigned build should pin exactly what went
     into it. `npm ci` is that pin's enforcement, and `npm ci || npm install`
     undoes it in precisely the case npm ci exists to catch — a lockfile that
     no longer satisfies package.json — by resolving whatever is newest that
     day and building green, with the workflow log as the only trace. A stale
     lockfile must fail the build loudly; the fix is a one-commit regen. */
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.match(workflow, /^\s*run: npm ci\s*$/m,
    'the workflow no longer installs the shell\'s build tools with npm ci alone');
  assert.doesNotMatch(workflow, /npm ci\s*\|\|/,
    'a fallback after npm ci ships whatever resolves that day instead of what the lockfile pinned');
});

test('a release is signed with the update key, and refuses to ship unsigned once apps carry a key', async () => {
  /* Installed apps trust an update only through release.json.sig. This runs
     the real staging script against stand-in build outputs and holds what it
     writes to what the updater will accept — and holds it to refusing to
     publish a release those apps would reject. */
  const crypto = await import('node:crypto');
  const { verifyReleaseManifest, manifestAsset } = await import('../desktop/updater.js');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const built = [`Zelos-${version}-arm64.dmg`, `Zelos-${version}-x64.dmg`, `Zelos-${version}-arm64.zip`, `Zelos-${version}-x64.zip`,
    `Zelos-${version}-setup-arm64.exe`, `Zelos-${version}-setup-x64.exe`, 'zelos-source.zip'];
  const stage = (keys, signingKey, transition = '') => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-release-'));
    fs.mkdirSync(path.join(work, 'desktop'));
    fs.mkdirSync(path.join(work, 'release-assets'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(work, 'package.json'));
    const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
    desktop.updates.publicKeys = keys;
    fs.writeFileSync(path.join(work, 'desktop', 'package.json'), JSON.stringify(desktop));
    for (const name of built) fs.writeFileSync(path.join(work, 'release-assets', name), Buffer.alloc(2048, name.length));
    const env = { ...process.env, GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: 'a'.repeat(40) };
    delete env.ZELOS_UPDATE_SIGNING_KEY;
    if (signingKey) env.ZELOS_UPDATE_SIGNING_KEY = signingKey;
    delete env.ZELOS_UPDATE_KEY_TRANSITION;
    if (transition) env.ZELOS_UPDATE_KEY_TRANSITION = transition;
    let failed = null;
    try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-release.mjs')], { cwd: work, stdio: 'pipe', env }); } catch (err) { failed = String(err.stderr); }
    return { work, failed };
  };
  const cleanup = [];
  try {
    const signed = stage([x], pem);
    cleanup.push(signed.work);
    assert.equal(signed.failed, null, signed.failed);
    const assets = path.join(signed.work, 'release-assets');
    const manifest = verifyReleaseManifest(fs.readFileSync(path.join(assets, 'release.json')), fs.readFileSync(path.join(assets, 'release.json.sig'), 'utf8'), [x], { version });
    for (const name of built) {
      const entry = manifestAsset(manifest, name);
      assert.ok(entry, `${name} is in the signed manifest`);
      assert.equal(entry.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, name))).digest('hex'));
    }

    const unsigned = stage([x], null);
    cleanup.push(unsigned.work);
    assert.match(unsigned.failed ?? '', /must be signed/, 'a keyed build may not ship unsigned');

    const otherPem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const wrong = stage([x], otherPem);
    cleanup.push(wrong.work);
    assert.match(wrong.failed ?? '', /not signed with the Zelos update key/, 'a secret that does not match the shipped key fails the release');

    // Moving apps to a new key: the release ships only the new key but is
    // signed with the old one, which is what the installed apps trust.
    const next = crypto.generateKeyPairSync('ed25519');
    const nextX = next.publicKey.export({ format: 'jwk' }).x;
    const blocked = stage([nextX], pem);
    cleanup.push(blocked.work);
    assert.match(blocked.failed ?? '', /not signed with the Zelos update key/, 'without the transition variable the old key is refused');
    const moving = stage([nextX], pem, x);
    cleanup.push(moving.work);
    assert.equal(moving.failed, null, moving.failed);
    const { checkSignedRelease } = await import('../scripts/update-signing.mjs');
    const movingDesktop = JSON.parse(fs.readFileSync(path.join(moving.work, 'desktop', 'package.json'), 'utf8'));
    const movingAssets = path.join(moving.work, 'release-assets');
    assert.equal(checkSignedRelease({ dir: movingAssets, desktop: movingDesktop, version, env: { ZELOS_UPDATE_KEY_TRANSITION: x } }), true,
      'publish-release accepts the transition release with the same variable');
    assert.throws(() => checkSignedRelease({ dir: movingAssets, desktop: movingDesktop, version, env: {} }), /not signed/,
      'and refuses it without');
    assert.throws(() => checkSignedRelease({ dir: movingAssets, desktop: movingDesktop, version, env: { ZELOS_UPDATE_KEY_TRANSITION: nextX } }), /still ships/);
    fs.rmSync(path.join(movingAssets, 'release.json.sig'));
    assert.throws(() => checkSignedRelease({ dir: movingAssets, desktop: movingDesktop, version, env: {} }), /must be signed/,
      'publish-release refuses a keyed release with no signature');

    const keyless = stage([], null);
    cleanup.push(keyless.work);
    assert.equal(keyless.failed, null, 'before a key exists, releases still build');
    assert.equal(fs.existsSync(path.join(keyless.work, 'release-assets', 'release.json.sig')), false);
  } finally {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Mac build makes the ZIPs the updater installs, and CI keeps them', () => {
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  const zip = desktop.build.mac.target.find((t) => t.target === 'zip');
  assert.deepEqual(zip?.arch, ['arm64', 'x64'], 'both Mac architectures need the ZIP an installed app updates from');
  assert.equal(desktop.build.mac.artifactName, '${productName}-${version}-${arch}.${ext}');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.match(workflow, /desktop\/dist\/\*\.zip/, 'the macOS job must upload the ZIPs it built');
  assert.equal(desktop.dependencies, undefined, 'the updater adds no runtime dependency to the shell');
});
