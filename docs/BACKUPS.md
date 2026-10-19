# Back up and restore Zelos

In the desktop app, open **Settings → Your data → Create a backup**. Choose a
private location, preferably on a different disk. The `.zelos-backup` file contains
the full SQLite database: archived messages and events, board items, drafts,
captured notes, search data, runs, revision history, and stored application state.
It also contains `config.json` and Zelos's local credential metadata. Local
encrypted-file credentials include both `secrets.enc` and `.seed` so they can be
restored on another computer.

**The backup is sensitive and is not password protected.** Its archive data is
readable, and a backup containing `.seed` can decrypt the included credential
file. Owner-only file permissions are the default; the protection offered by an
external disk or cloud provider still depends on that destination. Do not upload
a backup to an issue tracker or send it with a diagnostic report.

Operating-system keychain entries and Windows DPAPI credentials are not exported.
They may still work on the same computer, but you may need to reconnect accounts
and your model on another computer. A backup carries the home's credential
identity. So if you restore it into a second home on the same computer, the two
homes share their credentials in the system store (Keychain, DPAPI or
libsecret). Saving, replacing or forgetting a key in one changes it in the
other. Encrypted-file credentials are the exception: each home keeps its own
copy. Restoring replaces the home's credential identity with the backup's.
Restoring a backup of this same home changes nothing. Restoring another home's
backup over a setup that already had its own credentials in the system store
leaves those credentials there but unused, so reconnect anything the backup did
not cover. Copy local calendar files outside the Zelos folder separately.
Logs, cache files, window geometry, open connections, and previous backup
archives are not included. A backup contains saved settings;
finish editing other forms before creating one. Draft text is flushed automatically.

## Restore

Choose **Restore a backup**, select the file, and review the native confirmation.
It shows the backup date, Zelos version, record counts, and credential limitations.
Cancellation changes nothing. After confirmation Zelos finishes draft saves,
pauses requests and sweeps, cancels pending sign-ins, and waits for existing
writes. If a write will not finish, the operation stops and the current board
stays open. Copy any draft text that cannot be saved before leaving the app.

Close other copies of Zelos and AI clients using its MCP server first. Current
versions publish connection leases and refuse replacement while another client
has the data open. Older Zelos versions predate these leases: close those processes
manually, including background AI clients, before restoring. The older advisory
home lock is also checked; there is no force-takeover option.

Before replacement, Zelos creates a private `Before-restore-….zelos-backup` in the
data folder's `backups` directory. This recovery copy is retained after success or
failure. Restore then replaces the portable data and reopens Zelos. Keep your
original backup until you have checked the restored board and connections.

An interrupted restore is recovered automatically at the next desktop launch,
before the database or configuration is opened. An unfinished replacement rolls
back; a committed replacement is retained. Recovery verifies its rollback copies
before changing anything. If recovery cannot finish, keep the whole data folder
intact, including `.restore-journal.json`, `.restore-*`, and `backups`. Do not
delete the journal to bypass the refusal. Recover from the retained archive with
assistance if the disk is damaged or no longer has enough free space.

The browser edition has no filesystem bridge. Quit every Zelos and MCP process,
then copy the whole data folder manually. Keep `.seed`, `secrets.enc`, and all
credential metadata together. Reopen Zelos after copying; do not copy a live
SQLite database alone while its WAL is changing.

## Portable format, version 1

The format uses only Node built-ins and SQLite. A file starts with the ASCII
bytes `ZELOS-BACKUP\r\n\x1a\n`, a four-byte unsigned big-endian JSON-header length,
then the UTF-8 JSON header. Raw file contents follow sequentially in the order of
the header's `files` array. Each entry has a relative `path`, byte `size`, and
hexadecimal SHA-256 digest. The header also records `format`, `createdAt`,
`appVersion`, `schemaVersion`, `counts`, and credential portability. There is no
compression, executable payload, path supplied by the web page, or base64 copy
of the database held in memory.

The exporter takes a consistent SQLite `VACUUM INTO` snapshot, including committed
WAL content. Restore accepts only known portable filenames, rejects links and
duplicate/traversing paths, verifies every digest and total length, and checks
SQLite integrity, references, and the exact supported schema before confirmation.
Version 1 currently requires the same database schema as the installed app; use
the Zelos version that created a backup if a later or earlier schema is refused.
The limits are 64 GB of file data, 10,000 files, a 1 MB header, and 16 MB per
non-database file. Allow free disk space for staging, a recovery archive, and a
rollback copy in addition to the final restored data.

SHA-256 detects damage; it does not authenticate the sender. Restore only a
backup you trust. No credential bytes or selected filesystem paths are returned
through HTTP or the renderer's native bridge.
