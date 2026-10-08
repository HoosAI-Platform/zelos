import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { REPOSITORY } from '../core/updates.mjs';
import { macFeed } from '../desktop/updater.js';

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

// One Squirrel.Mac feed per architecture, naming this release's own ZIP. An
// installed Zelos reads it only after verifying the release itself, and checks
// it names exactly this version and this ZIP before Squirrel sees it (see
// desktop/updater.js). Written before the checksums, so they cover it too.
// Whole seconds: Squirrel.Mac reads pub_date without fractional seconds.
const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
for (const arch of ['arm64', 'x64']) {
  const feed = macFeed({ version, publishedAt, url: `${REPOSITORY}/releases/download/v${version}/Zelos-${version}-${arch}.zip` });
  const name = `zelos-update-mac-${arch}.json`;
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(feed, null, 2)}\n`);
  names.push(name);
}
const assets = names.map((name) => {
  const file = path.join(dir, name);
  const bytes = fs.readFileSync(file);
  // The update feeds are a few hundred bytes of JSON; every other asset is a real build.
  if (bytes.length < (name.endsWith('.json') ? 100 : 1000)) throw new Error(`Empty or invalid release asset: ${name}`);
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), assets.map((a) => `${a.sha256}  ${a.name}\n`).join(''));
fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify({ version, commit, assets }, null, 2)}\n`);
console.log(`Verified ${assets.length} assets for ${tag}`);
