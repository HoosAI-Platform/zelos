/**
 * scripts/generate-update-key.mjs — make a Zelos update key pair.
 *
 *   node scripts/generate-update-key.mjs <private-key-file>
 *
 * Writes the private key (PKCS#8 PEM) to the file named, readable only by you,
 * and refuses to overwrite one that exists. Prints the public key in the form
 * desktop/package.json carries it. The private key never goes into this
 * repository: it becomes the ZELOS_UPDATE_SIGNING_KEY Actions secret, plus an
 * offline copy you keep somewhere safe. docs/RELEASING.md § Automatic updates
 * says what to do with each half, and what to do if the private key is lost or
 * leaks.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/generate-update-key.mjs <private-key-file>');
  process.exit(2);
}
const file = path.resolve(target);
if (fs.existsSync(file)) {
  console.error(`${file} already exists. Choose a new file name; an update key is never overwritten.`);
  process.exit(1);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (file.startsWith(repo + path.sep)) {
  console.error('Write the private key outside this repository, so it can never be committed.');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const x = publicKey.export({ format: 'jwk' }).x;

console.log(`Private key written to ${file}

1. Add it to GitHub as a secret of the protected "release" environment (set
   that environment up first; docs/RELEASING.md § Turning it on):
     gh secret set ZELOS_UPDATE_SIGNING_KEY --env release < "${file}"
2. Keep an offline copy somewhere safe (a password manager or an encrypted
   drive), then delete this file from this computer.
3. Add the public key to desktop/package.json:
     "updates": { "publicKeys": ["${x}"], ... }
`);
