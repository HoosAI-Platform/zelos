# Releasing Zelos

1. Bump the version in package.json, desktop/package.json, and both root version fields in desktop/package-lock.json. Update RELEASE-NOTES.md.
2. Run the full suite and `node scripts/build-website.mjs`. Review the built demo. Merge only after the supported operating-system and Node checks pass.
3. Tag that exact commit `v<version>` and push the tag. The desktop workflow runs the suite, builds both Mac and Windows architectures, checks the versions, and publishes a GitHub release only after both builds succeed. The release includes the exact source archive, checksums, and a manifest with the commit.
4. Download the `zelos-website` artifact from that tag's workflow. Publish that directory to the existing Netlify site `zelos-app` (site ID `3d9cce7b-a802-4587-8ae4-51ab51bd8906`). For example: `netlify deploy --site 3d9cce7b-a802-4587-8ae4-51ab51bd8906 --dir <artifact-directory> --no-build --prod`. Use an authenticated Netlify account; never put a token in this repository.
5. Check the live release.json, demo version, and all download redirects. They must name the same tag. Download and inspect at least one packaged app and confirm its version and source commit.

Manual desktop workflow runs preserve installers as workflow artifacts without publishing a release. Tag releases do not automatically publish the website because Netlify credentials are not stored in GitHub. The matching website artifact is retained for deployment and rollback. To roll back the website, restore the previous Netlify deployment; previous GitHub releases remain available. Do not move or reuse a published tag.

Signing and notarisation are not configured. Set up publisher certificates and provider OAuth registrations separately before claiming a warning-free installation or a shared one-click provider sign-in.

## Automatic updates

Each tagged release also carries what an installed desktop app updates from: `Zelos-<version>-arm64.zip` and `Zelos-<version>-x64.zip` (the Mac app), the Windows installers, and `release.json` with its signature `release.json.sig`. Installed apps read only the latest stable release of `HoosAI-Platform/zelos`; a draft or prerelease is never offered.

An installed app accepts an update only when `release.json.sig` is a valid Ed25519 signature over `release.json`, made with the **Zelos update key**, and the downloaded file matches the size and SHA-256 that `release.json` lists. The updater (`desktop/updater.js`) stays off in any build whose `desktop/package.json` has no public key in `updates.publicKeys`.

### Turning it on

1. **Protect where the key will live.** In the repository's Settings → Environments, create an environment named `release`. Add yourself (and anyone else who may publish) as a required reviewer, and under deployment branches and tags allow only tags matching `v*`. In Settings → Rules, add a tag ruleset for `v*` that restricts who can create, update and delete those tags. The release job runs in this environment, so a pushed branch or workflow can never read the key, and a pushed tag cannot use it until a reviewer approves that run.
2. On a trusted computer, outside this repository, run `node scripts/generate-update-key.mjs ~/zelos-update-key.pem`. It writes the private key (readable only by you) and prints the public key.
3. Add the private key as a secret **of the `release` environment**, not of the repository: `gh secret set ZELOS_UPDATE_SIGNING_KEY --env release < ~/zelos-update-key.pem`.
4. Keep an offline copy of the private key (a password manager or an encrypted drive), then delete the file from the computer. Never commit it, paste it into an issue or chat, or put it anywhere but those two places.
5. Put the printed public key in `desktop/package.json` → `updates.publicKeys` and release normally. From then on `scripts/prepare-release.mjs` refuses to build a release it cannot sign, and both it and `scripts/publish-release.mjs` check the signature before anything is published.
6. Apps from earlier versions cannot update themselves to the first keyed release; their manual check points people at the release page.

**What this protects against, and what it does not.** Someone who can change files on a GitHub release, but cannot get the release job approved, cannot get an update accepted. Someone who can get a malicious commit tagged and the release run approved can — the key signs whatever that job builds. Approving a release run is therefore the same as shipping code to every installed copy: approve only a tag you made, on a commit you have reviewed.

Apple and Microsoft certificates are not needed for updating. They still remove the first-install warnings, and once a Windows certificate exists, setting `updates.windowsPublisher` makes the updater require that Authenticode publisher as well.

### Changing the key

Installed apps trust every key in their own `updates.publicKeys`, and a release must be signed by one of those. So moving to a new key always takes one release signed with the old key that ships the new one.

**Planned change.** Generate the new key. Add its public key beside the old one in `updates.publicKeys` and release, still signed with the old key. Then replace the `release` environment's `ZELOS_UPDATE_SIGNING_KEY` with the new private key, remove the old public key, and release again. Apps that installed the middle release follow along; one that skipped it straight to the last would not accept it, so leave at least a few weeks between the two.

**If the private key leaks:**

1. Review who can approve the `release` environment and push `v*` tags, and rotate any GitHub credentials that may be exposed. The key alone cannot publish a release; it needs that access too.
2. Generate a new key. Set `updates.publicKeys` to **only** the new public key.
3. Set the repository variable `ZELOS_UPDATE_KEY_TRANSITION` to the **old** public key (Settings → Secrets and variables → Actions → Variables). Leave the old private key as the secret for this one release: the release scripts then sign with it and check against it rather than against the new key the release ships.
4. Release. Every app that installs it trusts only the new key from then on.
5. Replace the secret with the new private key, delete `ZELOS_UPDATE_KEY_TRANSITION`, and sign every later release with the new key.

An app that never installs the transition release keeps trusting the leaked key, so anyone who holds it and can also publish a release could still update that app. Publish the transition release quickly and keep it the latest release until most apps have moved.

**If the private key is lost** (no secret, no offline copy), installed apps can never accept another update. Generate a new key, release with it, and tell people to download and install that release by hand once.

### Testing

Before relying on a release, test it end to end: publish two stable releases signed with a test key (the updater ignores prereleases) to a scratch repository, from builds with that repository in `core/updates.mjs` and `ui/lib/updates.js`, install the first on Apple silicon, Intel, Windows x64 and Windows on Arm, and confirm each updates to the second with its data, drafts and window position intact.

**A bad release.** Never move or reuse a tag. Publish a fixed patch version; installed apps update to whichever stable release is latest. To stop a bad release spreading before the fix is ready, mark it as a prerelease on GitHub, which makes the previous release "latest" again. Apps that already downloaded the bad version still need the fixed one.

**Moving from `HoosAILLC/zelos`.** Releases up to 1.8.1 were published to `HoosAILLC/zelos`, and those installed apps check only there. Publish the first `HoosAI-Platform` release to `HoosAILLC/zelos` as well, so their manual check finds it and links to it.
