import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe } from '../core/connectors/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.site-dist');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'website'), out, { recursive: true });
fs.cpSync(path.join(root, 'ui'), path.join(out, 'demo'), { recursive: true });
// The adapter keeps all demo data and mutations in memory. Every view is the release UI.
fs.cpSync(path.join(root, 'website/demo'), path.join(out, 'demo'), { recursive: true });
fs.mkdirSync(path.join(out, 'demo/assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'assets/icon.svg'), path.join(out, 'demo/assets/icon.svg'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'website/demo-data.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'demo/lib/demo-data.js'), `export default ${JSON.stringify({ ...data, version })};\n`);
fs.writeFileSync(path.join(out, 'demo/lib/connectors.js'), `export default ${JSON.stringify(describe())};\n`);
let html = fs.readFileSync(path.join(out, 'demo/index.html'), 'utf8')
  .replace('<title>Zelos</title>', '<title>Zelos — live demo</title>')
  .replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./')
  .replace('</head>', '<link rel="stylesheet" href="./demo.css">\n</head>')
  .replace('</body>', '<script type="module" src="./demo-banner.js"></script>\n</body>');
fs.writeFileSync(path.join(out, 'demo/index.html'), html);
const scriptHashes = new Set();
for (const name of ['index.html', 'help.html', 'privacy.html']) {
  const target = path.join(out, name);
  const page = fs.readFileSync(target, 'utf8').replaceAll('{{VERSION}}', version);
  fs.writeFileSync(target, page);
  for (const match of page.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    scriptHashes.add(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  }
}
const headers = path.join(out, '_headers');
fs.writeFileSync(headers, fs.readFileSync(headers, 'utf8').replace('{{SCRIPT_HASHES}}', [...scriptHashes].join(' ')));
const base = `https://github.com/HoosAI-Platform/zelos/releases/download/v${version}`;
const downloads = {
  'Zelos-mac-apple-silicon.dmg': `Zelos-${version}-arm64.dmg`,
  'Zelos-mac-intel.dmg': `Zelos-${version}-x64.dmg`,
  'Zelos-windows-x64.exe': `Zelos-${version}-setup-x64.exe`,
  'Zelos-windows-arm64.exe': `Zelos-${version}-setup-arm64.exe`,
  'zelos-source.zip': 'zelos-source.zip',
  'SHA256SUMS.txt': 'SHA256SUMS.txt',
};
const redirects = Object.entries(downloads).flatMap(([alias, name]) =>
  [...new Set([alias, alias.toLowerCase()])].map((a) => `/downloads/${a} ${base}/${name} 302!`));
fs.writeFileSync(path.join(out, '_redirects'), `${redirects.join('\n')}\n`);
const releaseFile = path.join(root, 'release-assets/release.json');
const release = fs.existsSync(releaseFile) ? JSON.parse(fs.readFileSync(releaseFile, 'utf8')) : {
  version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
};
if (release.version !== version) throw new Error('Release assets do not match this website version');
fs.writeFileSync(path.join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
fs.rmSync(path.join(out, 'demo-data.json'));
console.log(`Built website and demo for Zelos ${version}`);
