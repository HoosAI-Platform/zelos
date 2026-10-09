/**
 * scripts/update-signing.mjs — which update keys a release is checked against.
 *
 * Shared by prepare-release.mjs (which signs) and publish-release.mjs (which
 * refuses to publish what does not verify), so the two cannot disagree.
 *
 * Normally a release's signature must verify against the public keys the
 * release itself ships in desktop/package.json. The exception is the one
 * release that moves installed apps to a new key after the old one leaked or
 * is retired: it ships only the new key but must be signed with the old one,
 * because that is the key the installed apps trust. For that release the
 * repository variable ZELOS_UPDATE_KEY_TRANSITION names the old public key,
 * and the signature is checked against it instead. docs/RELEASING.md says
 * when to set it and when to remove it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { publicKeyFrom, verifyReleaseManifest } from '../desktop/updater.js';

export function releaseKeys({ desktop, env = process.env }) {
  const shipped = (desktop.updates?.publicKeys ?? []).filter((key) => publicKeyFrom(key));
  const transition = String(env.ZELOS_UPDATE_KEY_TRANSITION ?? '').trim();
  if (!transition) return { shipped, checkAgainst: shipped, transition: false };
  if (!publicKeyFrom(transition)) throw new Error('ZELOS_UPDATE_KEY_TRANSITION is not a valid update public key');
  if (shipped.includes(transition)) throw new Error('ZELOS_UPDATE_KEY_TRANSITION names a key this release still ships; remove it from updates.publicKeys or unset the variable');
  return { shipped, checkAgainst: [transition], transition: true };
}

/** Throws unless release-assets holds a release.json signed as releaseKeys says it must be. */
export function checkSignedRelease({ dir, desktop, version, env = process.env }) {
  const { shipped, checkAgainst } = releaseKeys({ desktop, env });
  const sigFile = path.join(dir, 'release.json.sig');
  if (!fs.existsSync(sigFile)) {
    if (shipped.length) throw new Error('desktop/package.json names update keys, so the release must be signed: set ZELOS_UPDATE_SIGNING_KEY');
    return false;
  }
  // Before any key ships there is nothing to check a signature against, and
  // no installed app that would read one.
  if (!checkAgainst.length) return true;
  verifyReleaseManifest(fs.readFileSync(path.join(dir, 'release.json')), fs.readFileSync(sigFile, 'latin1'), checkAgainst, { version });
  return true;
}
