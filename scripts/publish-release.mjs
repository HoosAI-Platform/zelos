import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { checkSignedRelease } from './update-signing.mjs';

const release = JSON.parse(fs.readFileSync('release-assets/release.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${release.version}` || process.env.GITHUB_SHA !== release.commit) throw new Error('Release identity mismatch');
const files = release.assets.map(({ name, sha256 }) => {
  if (!name || path.basename(name) !== name || /[\\/]/.test(name)) throw new Error('Invalid asset name');
  const file = path.join('release-assets', name);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== sha256) throw new Error(`Release asset changed: ${name}`);
  return file;
});
// electron-builder can leave an extra universal installer. Publish only the verified set.
// Checked again here rather than trusted from the step before: installed apps
// that carry the update key will not update to a release without a valid one.
const desktop = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
const signature = checkSignedRelease({ dir: 'release-assets', desktop, version: release.version })
  ? ['release-assets/release.json.sig'] : [];
execFileSync('gh', ['release', 'create', tag, ...files, 'release-assets/SHA256SUMS.txt',
  'release-assets/release.json', ...signature, '--verify-tag', '--title', `Zelos ${release.version}`,
  '--notes-file', 'docs/RELEASE-NOTES.md'], { stdio: 'inherit' });
