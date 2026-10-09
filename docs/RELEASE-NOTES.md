# Zelos 1.9.4

This release makes updates that are ready to install stay ready.

- **Ready updates are remembered:** An update Zelos has downloaded is kept when you quit. The next time you open Zelos it is checked again and offered straight away, in the banner and in Settings → About, without downloading it a second time.
- **Newer versions are still noticed:** While an update waits to be installed, Zelos keeps checking. If a newer version comes out, it replaces the waiting one.

## Install or update

**From 1.9.0 or later:** Zelos updates itself. From 1.9.2, a banner at the top of the window says when this version is ready; choose **Restart to update**, **Remind me later** or **Skip this version**. You can also install it from Settings → About, the app menu or the tray. Your drafts are saved first.

**From 1.8.1 or earlier:** install this version by hand once. Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application; your data folder is kept. For automatic updates afterwards, on a Mac drag Zelos into **Applications** and open it from there, and on Windows install it **only for you**.

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS, so a first install shows an operating-system warning; see INSTALL.md for what to click. Only continue if you trust this release.
