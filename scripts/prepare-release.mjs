import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { signManifest } from '../desktop/updater.js';
import { checkSignedRelease, releaseKeys } from './update-signing.mjs';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const desktop = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${version}` || desktop.version !== version) throw new Error('Release tag and app versions must match');
const commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Release requires the full source commit');
const dir = 'release-assets';
const names = [`Zelos-${version}-arm64.dmg`, `Zelos-${version}-x64.dmg`,
  `Zelos-${version}-arm64.zip`, `Zelos-${version}-x64.zip`,
  `Zelos-${version}-setup-arm64.exe`, `Zelos-${version}-setup-x64.exe`, 'zelos-source.zip'];

const assets = names.map((name) => {
  const file = path.join(dir, name);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 1000) throw new Error(`Empty or invalid release asset: ${name}`);
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), assets.map((a) => `${a.sha256}  ${a.name}\n`).join(''));
const manifest = Buffer.from(`${JSON.stringify({ version, commit, assets }, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'release.json'), manifest);

// Installed apps trust an update only through release.json.sig: an Ed25519
// signature over release.json's exact bytes, made with the private update key
// (a secret of the protected `release` environment; generate-update-key.mjs
// makes the pair). A build that carries public keys must ship signed, and the
// signature is checked before anything is published, so a wrong or retired
// secret fails the release instead of every installed app's next update.
const signingKey = process.env.ZELOS_UPDATE_SIGNING_KEY;
const keys = releaseKeys({ desktop });
if (signingKey) {
  let privateKey;
  try { privateKey = crypto.createPrivateKey(signingKey); } catch { throw new Error('ZELOS_UPDATE_SIGNING_KEY is not a readable private key'); }
  fs.writeFileSync(path.join(dir, 'release.json.sig'), signManifest(manifest, privateKey));
  console.log(keys.transition ? 'Signed release.json with the outgoing key; this release moves installed apps to the new key' : 'Signed release.json with the update key');
}
checkSignedRelease({ dir, desktop, version });
console.log(`Verified ${assets.length} assets for ${tag}`);
