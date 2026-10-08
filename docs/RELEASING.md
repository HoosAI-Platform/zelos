# Releasing Zelos

1. Bump the version in package.json, desktop/package.json, and both root version fields in desktop/package-lock.json. Update RELEASE-NOTES.md.
2. Run the full suite and `node scripts/build-website.mjs`. Review the built demo. Merge only after the supported operating-system and Node checks pass.
3. Tag that exact commit `v<version>` and push the tag. The desktop workflow runs the suite, builds both Mac and Windows architectures, checks the versions, and publishes a GitHub release only after both builds succeed. The release includes the exact source archive, checksums, and a manifest with the commit.
4. Download the `zelos-website` artifact from that tag's workflow. Publish that directory to the existing Netlify site `zelos-app` (site ID `3d9cce7b-a802-4587-8ae4-51ab51bd8906`). For example: `netlify deploy --site 3d9cce7b-a802-4587-8ae4-51ab51bd8906 --dir <artifact-directory> --no-build --prod`. Use an authenticated Netlify account; never put a token in this repository.
5. Check the live release.json, demo version, and all download redirects. They must name the same tag. Download and inspect at least one packaged app and confirm its version and source commit.

Manual desktop workflow runs preserve installers as workflow artifacts without publishing a release. Tag releases do not automatically publish the website because Netlify credentials are not stored in GitHub. The matching website artifact is retained for deployment and rollback. To roll back the website, restore the previous Netlify deployment; previous GitHub releases remain available. Do not move or reuse a published tag.

Signing and notarisation are not configured. Set up publisher certificates and provider OAuth registrations separately before claiming a warning-free installation or a shared one-click provider sign-in.

## Automatic updates

Each tagged release also carries what an installed desktop app updates from: `Zelos-<version>-arm64.zip` and `Zelos-<version>-x64.zip` (the Mac app, for Squirrel.Mac), `zelos-update-mac-arm64.json` and `zelos-update-mac-x64.json` (the feeds `scripts/prepare-release.mjs` writes, each naming that release's own ZIP), and the Windows installers with `SHA256SUMS.txt`. All of them are in the checksum list. Installed apps read only the latest stable release of `HoosAI-Platform/zelos`; a draft or prerelease is never offered.

The updater (`desktop/updater.js`) stays off in any build that is not signed by the publisher. To turn it on:

1. **macOS.** Enrol in the Apple Developer Program and create a Developer ID Application certificate and an App Store Connect API key. Add them to the repository's Actions secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). In `desktop/package.json` remove `"identity": "-"`, set `hardenedRuntime` and `notarize` to `true`, and add an entitlements file allowing JIT (`com.apple.security.cs.allow-jit`). Remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from `.github/workflows/desktop.yml`. Set `updates.macTeamId` to the ten-character team ID.
2. **Windows.** Obtain code signing (Azure Trusted Signing, or an OV/EV certificate), add the credentials as secrets, and configure `build.win` to sign. Set `updates.windowsPublisher` to the certificate subject's CN exactly as Windows shows it as the publisher.
3. Release the first signed version normally. Apps from earlier versions cannot update themselves to it; their manual check points people at the release page.

Before relying on a release, test it end to end: publish two signed stable releases (the updater ignores prereleases) to a scratch repository, from builds with that repository in `core/updates.mjs` and `ui/lib/updates.js`, install the first on Apple silicon, Intel, Windows x64 and Windows on Arm, and confirm each updates to the second with its data, drafts and window position intact.

**A bad release.** Never move or reuse a tag. Publish a fixed patch version; installed apps update to whichever stable release is latest. To stop a bad release spreading before the fix is ready, mark it as a prerelease on GitHub, which makes the previous release "latest" again. Apps that already downloaded the bad version still need the fixed one.

**Moving from `HoosAILLC/zelos`.** Releases up to 1.8.1 were published to `HoosAILLC/zelos`, and those installed apps check only there. Publish the first `HoosAI-Platform` release to `HoosAILLC/zelos` as well, so their manual check finds it and links to it.
