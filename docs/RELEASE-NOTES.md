# Zelos 1.9.0

This release lets the desktop app keep itself up to date. From now on, Zelos finds new versions, downloads them, checks they are genuine, and installs them when you choose to restart. This is the last version you need to install by hand.

- **Automatic updates:** The Mac and Windows apps look for a new version when they open and every six hours, download it in the background, and show **Restart to update** in Settings → About, the app menu and the tray. Nothing is installed until you choose it, and your drafts are saved first. **Install updates automatically** in Settings → About turns this off.
- **Update checks carry nothing of yours:** Checks contact only the official Zelos release on GitHub, with no email, calendar data, credentials or AI keys. The browser and command-line versions still check only when you press **Check for updates**.

## Install or update

**From 1.8.1 or earlier, install this version by hand once.** Earlier versions cannot update themselves to it. Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application. Your existing data folder is kept.

For automatic updates to work afterwards:

- **Mac:** drag Zelos into your **Applications** folder and open it from there. A copy opened from the disk image, or from a folder your account cannot change, does not update itself. macOS may ask whether Zelos may update apps; allow it.
- **Windows:** choose to install Zelos **only for you**. An installation for all users needs an administrator to update, so it does not update itself; download new versions from this page instead.

Before upgrading, back up your data from Settings → Your data, or quit Zelos and copy your data folder (`~/.zelos` by default) to a safe place. Backup files are not password protected and may contain portable credentials.

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS, so the first install still shows an operating-system warning; see INSTALL.md for what to click. Only continue if you trust this release.

Google and Microsoft OAuth client registrations are not bundled. Gmail supports app-password setup when your account permits it; OAuth connections require the registration described in OAUTH.md. A model is needed for assessment and answers; sample data is available to explore the interface first. Zelos does not send messages or modify connected tasks.
