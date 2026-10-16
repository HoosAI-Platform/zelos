/**
 * core/doctor.mjs — "why isn't this working?", answered without a stack trace.
 *
 * `zelos doctor` is for the person who followed the instructions and got
 * nothing. Every check here ends in either "this is fine" or a sentence that
 * names the next thing to *do* — not the exception that was thrown. An error
 * message a user cannot act on is the same as no message at all.
 *
 * Three rules shape this file:
 *
 *  1. **It diagnoses; it does not repair.** The home-directory check reads the
 *     mode off disk *before* anything calls `paths()`, because `paths()`
 *     tightens the permissions as a side effect. A doctor that quietly fixes
 *     what it is measuring cannot tell you what was wrong.
 *  2. **It only talks to what you configured.** The model endpoint, your IMAP
 *     hosts and your calendar URLs — the same three outbound sockets the rest
 *     of Zelos is allowed. Nothing else, ever.
 *  3. **It never reads a secret out loud.** It reports whether a credential is
 *     *present*, never its value, and never puts one in a return value that a
 *     UI might render.
 *
 * `diagnose()` returns a plain JSON-safe report so the Settings screen can show
 * the same findings the terminal does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULTS, loadConfig, paths, validateConfig } from './config.mjs';
import { SCHEMA_VERSION, runtimeHasFts5 } from './db.mjs';
import { backend as secretBackend, getSecret as readSecret, setSecret as writeSecret, deleteSecret as removeSecret } from './secrets.mjs';
import { readModelKey, isModelKeyRef, LEGACY_MODEL_REF, UNPLACED_MODEL_REF } from './model-key.mjs';
import { isLocalAddress, listModels } from './llm.mjs';
import { guessImapHost, testConnection as testImapConnection } from './sources/imap.mjs';
import { testConnection as testCalDavConnection } from './sources/caldav.mjs';
import { parseICS } from './sources/ics.mjs';
import { safeUrl } from './safety.mjs';
import { localTimezone, nowISO } from './time.mjs';
/* The registry, for the same reason core/sweep.mjs reads it: a diagnostic that
   keeps its own list of source kinds is a second list, and the one that goes
   stale is always the one nobody is looking at. It costs no new weight here —
   every module the registry pulls in (core/sources/imap.mjs, caldav.mjs,
   ics.mjs) is already imported above. */
import { get as connectorFor, enabledSources, originsFor, unknownSources } from './connectors/index.mjs';
import { createHttp } from './connectors/http.mjs';
import { assertNoMaintenance, registerDataConnection } from './data-lease.mjs';

/**
 * The floor is not the version that added `node:sqlite` — it is the version
 * whose bundled SQLite has the FTS5 extension Zelos indexes with. Measured
 * against real runtimes rather than read off a changelog: 22.15 and 23.11 have
 * no FTS5, 22.16 and 24.0 do. So the 23 line is excluded entirely, which no
 * single "minimum version" can express.
 */
export const MIN_NODE = '22.16.0';
/** The whole of this major lacks FTS5, however new its number looks. */
const EXCLUDED_MAJOR = 23;

/** pass = fine · warn = worth knowing · fail = broken · skip = nothing to check */
export const STATUSES = Object.freeze(['pass', 'warn', 'fail', 'skip']);

const MAX_ICS_BYTES = 8 * 1024 * 1024;

const DEFAULT_DEPS = Object.freeze({
  backend: secretBackend,
  getSecret: readSecret,
  listModels,
  testImap: testImapConnection,
  testCalDav: testCalDavConnection,
  fetchImpl: (...args) => globalThis.fetch(...args),
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function check(id, label, status, detail, action = null) {
  return { id, label, status, detail: String(detail ?? ''), action: action ? String(action) : null };
}

function errorText(err) {
  return err?.message || String(err ?? 'unknown error');
}

/** "22.5.0" vs "26.3.0" — numeric, segment by segment, prerelease tags ignored. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Where Zelos lives, worked out WITHOUT creating anything. `paths()` would be
 * the obvious call, but it mkdirs and chmods on the way — which is exactly the
 * condition the home check exists to observe.
 *
 * The literal strings "undefined" and "null" are no override, exactly as in
 * core/config.mjs `homeDir()` — they are what `ZELOS_HOME=${home}` becomes
 * with `home` unset. This reader lacked that guard, so `ZELOS_HOME=undefined
 * zelos doctor` reported on $PWD/undefined while the app it was diagnosing
 * used ~/.zelos. A doctor has to look where the patient lives.
 */
function homeDirPath() {
  const override = process.env.ZELOS_HOME;
  const trimmed = override ? override.trim() : '';
  const garbage = trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null';
  return trimmed && !garbage ? path.resolve(override) : path.join(os.homedir(), '.zelos');
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

function checkNode(version = process.versions.node) {
  const label = 'Node.js';
  if (compareVersions(version, MIN_NODE) < 0) {
    return check(
      'node', label, 'fail',
      `This is Node ${version}. Zelos needs ${MIN_NODE} or newer — that is the release whose built-in SQLite carries the FTS5 extension its search index is built on.`,
      'Install the current Node from nodejs.org (take the defaults), close this terminal, open a new one, and run zelos again.',
    );
  }
  const major = Number.parseInt(String(version).split('.')[0], 10) || 0;
  if (major === EXCLUDED_MAJOR) {
    return check(
      'node', label, 'fail',
      `This is Node ${version}. The whole Node 23 line was built without SQLite's FTS5 extension, which Zelos uses for its search index — so it cannot open its database at all, however new the version number looks.`,
      'Install Node 24 or newer from nodejs.org, close this terminal, open a new one, and run zelos again.',
    );
  }
  return check('node', label, 'pass', `Node ${version}`);
}

function checkHome(home) {
  const label = 'Data folder';
  let stat;
  try {
    stat = fs.statSync(home);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return check(
        'home', label, 'warn',
        `${home} does not exist yet.`,
        'That is normal before the first launch — Zelos creates it, locked to your account, when it starts. Run zelos once.',
      );
    }
    return check(
      'home', label, 'fail',
      `${home} cannot be read: ${errorText(err)}`,
      `Check that the folder exists and belongs to you, or start Zelos with --home pointing somewhere you own.`,
    );
  }

  if (!stat.isDirectory()) {
    return check(
      'home', label, 'fail',
      `${home} is a file, not a folder.`,
      `Move or delete ${home}, then start Zelos again — it will create the folder itself.`,
    );
  }

  try {
    fs.accessSync(home, fs.constants.W_OK | fs.constants.R_OK);
  } catch {
    return check(
      'home', label, 'fail',
      `${home} exists but this account cannot write to it.`,
      `Give yourself access — on macOS or Linux: chmod u+rwx "${home}" — or start Zelos with --home pointing at a folder you own.`,
    );
  }

  const mode = stat.mode & 0o777;
  // Windows does not use POSIX modes; reporting one would be theatre.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return check(
      'home', label, 'fail',
      `${home} is readable by other accounts on this machine (mode ${mode.toString(8).padStart(3, '0')}). Your mail cache and your board live in there.`,
      `Zelos tightens this itself the next time it starts. Lock it down now with: chmod 700 "${home}" — and if it keeps coming back open, something else on this machine is widening it.`,
    );
  }

  const db = path.join(home, 'zelos.db');
  const detail = process.platform === 'win32'
    ? `${home}${fs.existsSync(db) ? ' · database present' : ' · no database yet'}`
    : `${home} (mode ${mode.toString(8).padStart(3, '0')})${fs.existsSync(db) ? ' · database present' : ' · no database yet'}`;
  return check('home', label, 'pass', detail);
}


/**
 * The database, actually opened.
 *
 * `diagnose()` used to import nothing from ./db.mjs and the folder check only
 * `existsSync`ed the file, so every one of these printed "✓ Data folder …
 * database present", "Nothing is broken", exit 0, on a home where `node
 * zelos.mjs` dies at startup with a bare `Error: file is not a database`:
 *
 *  - a truncated or half-synced zelos.db (a cloud-sync placeholder, a copy
 *    interrupted mid-write) — opens, then throws on the first statement;
 *  - a root-owned or mode-000 zelos.db, which is what one `sudo zelos` or a
 *    backup restored as root leaves behind — the open itself throws;
 *  - a zelos.db that is a directory — "disk I/O error" on open;
 *  - a file written by a NEWER Zelos. `migrate()` only ever moves forward and
 *    returns `{applied: 0}` without a word, and `SCHEMA_VERSION` is compared to
 *    nothing outside the tests, so an older build reads a newer file happily
 *    until it touches a column that is not there.
 *
 * Opened read-only, always: the rule at the top of this file is that doctor
 * diagnoses and does not repair, and a plain `open()` would create the file,
 * set WAL, tighten modes and run migrations — three of which are exactly the
 * conditions being measured. Read-only is also safe against a running Zelos:
 * measured against a live WAL writer holding the same file, the read-only
 * handle answers both PRAGMAs without disturbing it.
 */
function checkDatabase(home) {
  const label = 'Database';
  const file = path.join(home, 'zelos.db');

  /* Only the name, not the path, in every `detail` below. `wrap()` never breaks
     a word, so a full path is one unsplittable token — and a Zelos home under a
     long temp or profile directory then pushes the line past the terminal the
     rest of the report is written to fit. The folder is on the line above; the
     path appears only inside the mv commands, which have to be copy-pasteable. */
  const aside = `Close Zelos and move the file aside — mv "${file}" "${file}.broken" — then start Zelos again: it writes a fresh one. Your mail and calendars are read from their servers on the next sweep; what is lost is the board history and anything you captured.`;

  // The runtime first: on a first run there is no zelos.db yet, and "it has
  // not been created yet — nothing to do" would hide that this Node can never
  // create one (TT-3467).
  if (!runtimeHasFts5()) {
    return check(
      'database', label, 'fail',
      `This copy of Node (${process.version}) has a SQLite without the FTS5 extension, which Zelos's search index is built on — so it cannot open zelos.db at all.`,
      'Install an official Node from nodejs.org (22.16 or newer, or 24 or newer) and run zelos again. Nothing in your Zelos home has been changed.',
    );
  }

  if (!fs.existsSync(file)) {
    return check(
      'database', label, 'skip',
      'zelos.db has not been created yet.',
      'Nothing to do: Zelos creates it, with its tables, the first time it starts.',
    );
  }

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    return check('database', label, 'fail', `zelos.db cannot be opened: ${errorText(err)}`, aside);
  }

  try {
    // Read the version first. On a file whose header is intact but whose pages
    // are not, this succeeds and quick_check is what throws — reading them the
    // other way round would report a corrupt database as an unopenable one.
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
    const rows = db.prepare('PRAGMA quick_check').all();
    const verdict = rows.map((r) => String(r?.quick_check ?? '')).filter(Boolean);
    if (!(verdict.length === 1 && verdict[0].toLowerCase() === 'ok')) {
      return check(
        'database', label, 'fail',
        `zelos.db is damaged: ${verdict.slice(0, 3).join('; ') || 'SQLite reported no verdict'}`,
        aside,
      );
    }
    if (version > SCHEMA_VERSION) {
      return check(
        'database', label, 'fail',
        `zelos.db was written by a newer Zelos: its schema is version ${version} and this build understands ${SCHEMA_VERSION}.`,
        'Update Zelos. Migrations only ever move forward, so this build will not touch the file — it would simply read columns that are not there and go quiet about it. Do not delete the database: the newer Zelos can still read it.',
      );
    }
    return check(
      'database', label, 'pass',
      `zelos.db · schema ${version} of ${SCHEMA_VERSION}${version < SCHEMA_VERSION ? ' (it upgrades itself on the next launch)' : ''} · integrity ok`,
    );
  } catch (err) {
    return check('database', label, 'fail', `zelos.db is not a database Zelos can read: ${errorText(err)}`, aside);
  } finally {
    try { db.close(); } catch { /* the handle is going away regardless */ }
  }
}

/**
 * The sections of config.json whose value has to BE an object, named by reading
 * DEFAULTS rather than by keeping a second copy of the list here: the two
 * copies would drift the first time a section was added, and this one would go
 * quiet rather than loud when it did.
 */
const OBJECT_SECTIONS = Object.entries(DEFAULTS)
  .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
  .map(([k]) => k);

/**
 * Which sections the FILE gets wrong — not the loaded config.
 *
 * `loadConfig()` repairs a scalar section on the way in (it has to: doctor's own
 * advice is "edit config.json directly", and a typo there must not brick the app
 * that is supposed to report the typo). The repair is a `log.warn` and nothing
 * else, so validateConfig sees a perfectly good object and doctor said "valid"
 * about a file whose `"identity": 5` had just silently thrown the user's name
 * and address away. This is the one place that can still see it.
 */
function malformedSectionsOnDisk(configFile) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    // Unreadable or unparseable is config.mjs's business — it moves the file
    // aside — and the load error is already reported above.
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return OBJECT_SECTIONS.filter((key) => Object.hasOwn(raw, key)
    && (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key])));
}

function checkConfig(config, configFile, loadError) {
  const label = 'Settings file';
  if (loadError) {
    return check(
      'config', label, 'fail',
      `Zelos could not read its settings: ${loadError}`,
      `Look at ${configFile}. If it is damaged, move it aside — Zelos writes a fresh one with the defaults on the next launch.`,
    );
  }
  const { ok, errors } = validateConfig(config);
  if (!ok) {
    const shown = errors.slice(0, 6).map((e) => `${e.path || '(root)'} ${e.message}`).join('; ');
    const more = errors.length > 6 ? ` (and ${errors.length - 6} more)` : '';
    return check(
      'config', label, 'fail',
      `${errors.length} setting${errors.length === 1 ? '' : 's'} will not load: ${shown}${more}`,
      `Fix these in Settings inside the app, or edit ${configFile} directly and restart Zelos.`,
    );
  }
  if (!fs.existsSync(configFile)) {
    return check(
      'config', label, 'warn',
      'No settings file has been written yet — Zelos is running on its defaults.',
      'Nothing to do: the first change you save in Settings creates it.',
    );
  }
  const malformed = malformedSectionsOnDisk(configFile);
  if (malformed.length) {
    const one = malformed.length === 1;
    return check(
      'config', label, 'warn',
      `${configFile} loads, but ${malformed.join(', ')} ${one ? 'is not an object' : 'are not objects'} in the file — Zelos replaced ${one ? 'it' : 'them'} with the built-in defaults to get started, and whatever ${one ? 'that section' : 'those sections'} held is gone.`,
      `Open ${configFile} and give ${malformed.map((s) => `"${s}"`).join(', ')} ${one ? 'a JSON object' : 'JSON objects'} — "${malformed[0]}": {} is a valid one — then restart Zelos and set ${one ? 'that section' : 'those sections'} again in Settings. Saving anything in Settings also rewrites the file with the defaults in place, which stops the warning but does not bring the old values back.`,
    );
  }
  return check('config', label, 'pass', `${configFile} · valid`);
}

/**
 * Which store this folder's secrets were actually written to, read straight off
 * disk. `backend()` returns the store in USE, which since the pin landed is not
 * the same question — see core/secrets.mjs "the backend on record".
 */
function recordedBackend(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'secrets.backend.json'), 'utf8'));
    return typeof parsed?.backend === 'string' && parsed.backend ? parsed.backend : null;
  } catch {
    return null;
  }
}

async function checkSecrets(deps, home) {
  const label = 'Secret store';
  let info;
  try {
    info = await deps.backend();
  } catch (err) {
    return check(
      'secrets', label, 'fail',
      `Zelos could not work out where to keep your passwords: ${errorText(err)}`,
      'Unset ZELOS_SECRETS_BACKEND if you set it, or set it to encrypted-file to use the built-in encrypted store.',
    );
  }
  if (!info.writable) {
    return check(
      'secrets', label, 'fail',
      `The ${info.name} store cannot be written, so mail passwords and API keys have nowhere to go.`,
      'Check that your Zelos data folder is writable (the line above), then run zelos doctor again.',
    );
  }

  /* Where the name came from matters as much as the name. `backend()` answers
     "which store is in use", and since the first successful write pins the
     choice in secrets.backend.json, that answer can come from the record rather
     than from a live probe — which is the whole point of the record, and also
     why a clean "✓ macos-keychain" here used to be compatible with a keychain
     that is not answering at all. Doctor cannot re-probe without a seam
     secrets.mjs does not offer, but it can say which of the two it is looking
     at, and it can catch the one case where the record LOST. */
  const recorded = recordedBackend(home);
  const forced = String(process.env.ZELOS_SECRETS_BACKEND ?? '').trim();

  if (recorded && recorded !== info.name) {
    return check(
      'secrets', label, 'warn',
      `This folder's credentials were stored in ${recorded} — secrets.backend.json says so — but Zelos is using ${info.name} right now, and nothing ${recorded} holds can be read from here.`,
      forced
        ? `ZELOS_SECRETS_BACKEND is set to "${forced}" in this shell, and that beats the record on purpose. Unset it and run zelos doctor again. Anything you save while it is set lands in ${info.name} and will not be found by a run without it.`
        : `${recorded} does not exist on ${process.platform}, so this is a Zelos home that has moved machines. Re-enter your mail passwords and your model key in Settings; they will go into ${info.name} from now on.`,
    );
  }

  if (info.name === 'encrypted-file') {
    const pinned = recorded === 'encrypted-file';
    const why = process.platform === 'darwin' || process.platform === 'win32'
      ? `This machine does have a system store, so something stopped Zelos reaching it — a probe that timed out, or a sandbox that refused. `
      : 'On Linux, install a keyring (gnome-keyring or KWallet) and log back in to be offered one. ';
    return check(
      'secrets', label, 'warn',
      `Using the built-in encrypted file${pinned ? ', and this folder is now pinned to it by its own secrets.backend.json' : ''}. ${info.note}`,
      pinned
        ? `${why}Nothing is broken today and no password is lost, but this will not undo itself: once a secret has landed, the record beats the probe precisely so a keychain that turns up later cannot quietly become a second store holding half your credentials. Moving is a deliberate act — close Zelos, delete secrets.enc, .seed and secrets.backend.json from ${home}, then re-enter each password in Settings.`
        : `${why}Nothing is broken, and nothing has been stored yet — so if a keychain is working before you save your first password, Zelos will use that instead and this line will go away on its own.`,
    );
  }

  return check(
    'secrets', label, 'pass',
    recorded === info.name
      ? `${info.name} · recorded in this folder's secrets.backend.json as where its secrets live, so that is where Zelos looks even if a probe blinks. ${info.note}`
      : `${info.name} · chosen by probing this machine. Nothing has been stored yet, so the choice is not pinned. ${info.note}`,
  );
}

/*
 * A key from before keys were kept per service that is not this service's —
 * still in `model.default`, or set aside because no address could take it —
 * stays in the store, unused. Worth knowing either way; nothing is broken.
 */
async function olderKeyNote(deps, key) {
  for (const ref of [LEGACY_MODEL_REF, UNPLACED_MODEL_REF]) {
    let value = null;
    try { value = await deps.getSecret(ref); } catch { /* the secret store line reports this */ }
    if (value && value !== key) {
      return ' An older AI key, saved before Zelos kept one key per service, is also still stored; it could not be matched to this service, so it is not used.';
    }
  }
  return '';
}

async function checkModelKey(config, deps) {
  const label = 'AI key';
  const model = config?.model ?? {};
  const address = String(model.baseUrl ?? '').trim().replace(/\/+$/, '');
  // A model nobody has chosen yet means "not set up", not "broken". The
  // difference is the whole point of the exit code: `zelos doctor` fails when
  // something is wrong, not when someone simply has not finished yet.
  const chosen = String(model.model ?? '').trim();

  if (!address) {
    return { result: check('model.key', label, 'skip', 'No AI service has been chosen yet, so there is no key to check.'), key: null };
  }
  if (isLocalAddress(address)) {
    const older = await olderKeyNote(deps, null);
    return {
      result: older
        ? check('model.key', label, 'warn', `${address} runs on this machine — no API key needed.${older}`,
          'Open Settings → AI → Advanced and choose Forget the stored key to remove it.')
        : check('model.key', label, 'pass', `${address} runs on this machine — no API key needed.`),
      key: null,
    };
  }
  // The key saved for this address, and only that one (core/model-key.mjs). A
  // pre-upgrade key is moved here only against the real store, never a fake.
  const real = deps.getSecret === readSecret;
  let key = null;
  try {
    key = await readModelKey(model.baseUrl, {
      getSecret: deps.getSecret,
      setSecret: real ? writeSecret : null,
      deleteSecret: real ? removeSecret : null,
      configuredBaseUrl: model.baseUrl,
    });
  } catch (err) {
    return {
      result: check(
        'model.key', label, 'fail',
        `Zelos could not read the key it stored for ${address}: ${errorText(err)}`,
        'See the secret store line above — that is where this failed. Re-entering the key in Settings → AI usually settles it.',
      ),
      key: null,
    };
  }
  const older = await olderKeyNote(deps, key);
  if (!key) {
    return {
      result: check(
        'model.key', label, chosen ? 'fail' : 'warn',
        chosen
          ? `No key has been saved for this AI service, so every check will fail before it starts. For experts: the service is ${address}.${older}`
          : `No AI has been chosen yet, and no key has been saved for the AI service. For experts: the service is ${address}.${older}`,
        'Open Settings → AI and paste the key your AI service gave you. Zelos keeps it in this computer’s own password store — it is never written into the settings file, and it never appears in a log. If you would rather nothing left this computer at all, run Ollama or LM Studio and pick that instead; an AI on this computer needs no key.',
      ),
      key: null,
    };
  }
  if (older) {
    return {
      result: check(
        'model.key', label, 'warn',
        `A key is saved for this AI service (${address}).${older}`,
        'Open Settings → AI → Advanced and choose Forget the stored key to remove both, then paste your current key again.',
      ),
      key,
    };
  }
  return {
    result: check('model.key', label, 'pass', `A key is saved for this AI service. For experts: ${address}.`),
    key,
  };
}

async function checkModelEndpoint(config, deps, { key, keyChecked, timeoutMs, signal }) {
  const label = 'AI';
  const model = config?.model ?? {};
  const address = String(model.baseUrl ?? '').trim().replace(/\/+$/, '');
  const chosen = String(model.model ?? '').trim();

  if (!address) {
    return check(
      'model', label, 'fail',
      'No AI service has been chosen yet, so Zelos cannot think about anything it reads.',
      'Open Zelos, go to Settings → AI, and pick an AI service. If you want nothing to leave this computer at all, run Ollama or LM Studio and choose that.',
    );
  }
  if (!keyChecked) {
    return check(
      'model', label, 'skip',
      `Not checked — this AI service needs a key first (see above). For experts: ${address}.`,
      'Store the key, then run zelos doctor again.',
    );
  }

  const local = isLocalAddress(address);
  let models;
  try {
    models = await deps.listModels({
      protocol: model.protocol,
      baseUrl: address,
      apiKey: key,
      timeoutMs,
      retries: 0,
      signal,
    });
  } catch (err) {
    const status = err?.status ?? null;
    if (status === 401 || status === 403) {
      return check(
        'model', label, 'fail',
        `The AI service refused the stored key. For experts: ${address} answered HTTP ${status}.`,
        'The key is wrong, has been cancelled, or belongs to a different AI service. Make a fresh one on your AI service’s website and paste it into Settings → AI.',
      );
    }
    if (status === 404 || status === 405) {
      // The host answered — it just does not publish a model list. That is a
      // reachable endpoint, which is what this check is actually asking.
      return check(
        'model', label, 'pass',
        `The AI service answered. For experts: ${address} offers no model list, which is normal for some servers.`,
      );
    }
    if (status === 429) {
      return check(
        'model', label, 'warn',
        `The AI service answered, but is asking Zelos to slow down right now. For experts: ${address} answered HTTP 429.`,
        'Nothing is set up wrong. Wait a minute and check again; if it never clears, check your plan limits with the AI service.',
      );
    }
    if (status && status >= 500) {
      return check(
        'model', label, 'warn',
        `The AI service answered with an error at its own end. For experts: ${address} answered HTTP ${status}.`,
        'That is their end, not yours. Try again shortly.',
      );
    }
    return check(
      'model', label, 'fail',
      errorText(err),
      local
        ? `The AI program on this computer is not running. Start it first — for Ollama that is: ollama serve — then run zelos doctor again. For experts: nothing is listening at ${address}; check the port too — Ollama is 11434, LM Studio 1234, llama.cpp 8080.`
        : `Zelos could not reach the AI service. Check this computer’s internet connection. For experts: check the base URL in Settings → AI (${address}) against the AI service’s documentation.`,
    );
  }

  if (!chosen) {
    const sample = models.slice(0, 4).map((m) => m.id).join(', ');
    return check(
      'model', label, 'warn',
      `The AI service answers, but which of its AIs to use has not been chosen yet, so checks will not run. For experts: ${address}.`,
      sample
        ? `Open Settings → AI and pick one. This service offers: ${sample}${models.length > 4 ? ', and others' : ''}.`
        : 'Open Settings → AI and pick one.',
    );
  }
  if (models.length && !models.some((m) => m.id === chosen)) {
    const sample = models.slice(0, 4).map((m) => m.id).join(', ');
    return check(
      'model', label, 'warn',
      `The AI service answers, but does not list "${chosen}". For experts: ${address}.`,
      `Either the name has a typo or that AI has not been downloaded yet. Available here: ${sample}${models.length > 4 ? ', and others' : ''}. ${local ? `To fetch it in Ollama: ollama pull ${chosen}` : 'Pick one of those in Settings → AI.'}`,
    );
  }
  return check(
    'model', label, 'pass',
    `${chosen} at ${address}${local ? ' (on this machine)' : ''}${models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'} available` : ''}`,
  );
}

/**
 * Is the string under this account's `keyRef` a Microsoft grant, or a password?
 *
 * Parsed here rather than by importing `loadOAuthTokens`, because that function
 * reads core/secrets.mjs directly and this file reads secrets through
 * `deps.getSecret` — a diagnosis that bypassed the injected reader would be
 * testing a different machine's keychain than every other line in this report.
 * The `kind` field is what tells the two apart: a password that happens to be
 * valid JSON does not carry it, which is the case core/sources/imap.mjs:2032
 * names.
 */
function storedGrant(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.kind === 'xoauth2' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What an OAuth mailbox is missing, in the order a person can fix it, or null.
 *
 * Separate from the password path because none of its three failures has
 * anything to do with a password, and the advice underneath used to say so
 * anyway: "most sign-in failures here are a provider that refuses ordinary
 * passwords" is a true and completely useless sentence to read about an account
 * that is not sending one.
 */
function oauthTrouble(account, grant, name) {
  const clientId = String(account.oauth?.clientId ?? '').trim();
  // Absent is Microsoft: the field postdates the first connected accounts.
  const google = String(account.oauth?.provider ?? '').trim().toLowerCase() === 'google';
  const who = google ? 'Google' : 'Microsoft';
  if (!clientId) {
    return {
      detail: `${name} is set to sign in with ${who}, but no client ID is stored, so there is no registration to sign in against.`,
      action: google
        ? 'Open Settings → Email, edit this account and press "Sign in with Google" again — the client Zelos signed in through is saved on the account when the sign-in finishes.'
        : 'Open Settings → Email, edit this account and follow the steps under "Sign in with Microsoft" — '
          + 'they end with an application (client) ID and a directory (tenant) ID to paste in.',
    };
  }
  if (!grant) {
    return {
      detail: `${name} has a registration but has never been signed in on this machine, so there is no token to open the mailbox with.`,
      action: google
        ? 'Open Settings → Email, edit this account and press "Sign in with Google". A browser tab opens, you approve access, and the panel finishes on its own.'
        : 'Open Settings → Email, edit this account and press "Sign in with Microsoft". '
          + 'Zelos shows a code, you type it at microsoft.com/devicelogin, and the panel finishes on its own.',
    };
  }
  if (!grant.refreshToken) {
    return {
      detail: `${name} is signed in to ${who}, but the stored grant has no refresh token, so it will stop working within the hour.`,
      action: google
        ? 'Sign in again from Settings → Email and approve access when Google asks — a consent screen that was skipped is what leaves the refresh token out.'
        : 'The app registration has to request the offline_access scope. Add it under API permissions, then sign in again from Settings → Email.',
    };
  }
  return null;
}

async function checkMailAccount(account, deps, { timeoutMs }) {
  const name = account.label || account.host || account.id;
  const id = `mail.${account.id}`;
  const label = `Mail · ${name}`;
  const guess = guessImapHost(account.user || '');
  const oauth = account.auth === 'xoauth2';

  if (!account.host) {
    return check(id, label, 'fail', 'No IMAP server is set for this account.',
      `Open Settings → Email and fill in the server.${guess.host ? ` For ${account.user || 'that address'} it is usually ${guess.host}, port ${guess.port}.` : ''}`);
  }

  let stored = null;
  try {
    stored = account.keyRef ? await deps.getSecret(account.keyRef) : null;
  } catch (err) {
    return check(id, label, 'fail', `Zelos could not read the stored ${oauth ? 'Microsoft sign-in' : 'password'}: ${errorText(err)}`,
      `See the secret store line above. ${oauth ? 'Signing in again' : 'Re-entering the password'} in Settings → Email usually settles it.`);
  }

  const grant = storedGrant(stored);
  if (oauth) {
    const trouble = oauthTrouble(account, grant, name);
    if (trouble) return check(id, label, 'fail', trouble.detail, trouble.action);
  } else if (!stored) {
    return check(
      id, label, 'fail',
      `No password is stored for ${name}, so Zelos cannot sign in.`,
      `Open Settings → Email and enter it. ${guess.note}`,
    );
  } else if (grant) {
    /* A grant under an account that is set to send a password. It happens one
       way: somebody connected the mailbox to Microsoft and then switched the
       picker back. The sweep would send the whole JSON blob as a password —
       which fails, with `LOGIN failed`, about a mailbox the user just watched
       sign in successfully. */
    return check(
      id, label, 'fail',
      `${name} holds a Microsoft sign-in but is set to send a password, so Zelos would offer the stored token as one.`,
      'Open Settings → Email and set "How Zelos signs in" to "Sign in with Microsoft", or enter a password to replace the stored sign-in.',
    );
  }

  // `requireTls` is forwarded so this connects under the same rule the sweep
  // will. A diagnosis that signs in where the real run would refuse to is not a
  // diagnosis, it is a second, more permissive client — and it would report an
  // account as healthy on the morning its mail stops arriving. `auth` and the
  // `oauth` block are forwarded for exactly the same reason, and were not: the
  // doctor signed every account in with a password whatever the config said, so
  // an OAuth mailbox came back "sign-in failed" no matter how healthy it was.
  const result = await deps.testImap({
    host: account.host,
    port: account.port ?? 993,
    secure: account.secure !== false,
    user: account.user,
    pass: oauth ? '' : stored,
    auth: oauth ? 'xoauth2' : 'password',
    oauth: oauth
      ? {
        // Absent is Microsoft: the field postdates the first connected accounts.
        provider: String(account.oauth?.provider ?? '').trim().toLowerCase() || 'microsoft',
        clientId: String(account.oauth?.clientId ?? '').trim(),
        tenantId: String(account.oauth?.tenantId ?? '').trim() || 'common',
        tokenRef: account.keyRef,
      }
      : null,
    requireTls: account.requireTls ?? null,
    timeoutMs,
  });

  if (!result?.ok) {
    const reason = result?.error || 'the connection failed';
    // A refusal to send the password in the clear has to be recognised before
    // the sign-in advice below, because its wording mentions the password and
    // would otherwise be read as a rejected credential. Nothing was rejected:
    // nothing was sent, on purpose, and the fix is a port rather than a
    // different password.
    if (/still in the clear/i.test(reason)) {
      return check(
        id, label, 'fail',
        `${account.host}: ${reason}`,
        `Zelos stopped before your password left this machine. Use the TLS port in Settings → Email — ${guess.host ? `${guess.host}:${guess.port}` : 'usually 993'} — and if this host really is a local bridge that cannot do TLS, turn requireTls off for this account.`,
      );
    }
    const authish = /auth|login|credential|password|invalid|denied|token|oauth/i.test(reason);
    /* An OAuth account gets its own sentence, and the reason is that the one
       below is actively misleading for it. "Most sign-in failures here are a
       provider that refuses ordinary passwords" is what a user of a mailbox that
       sends no password would read while their real problem — a revoked grant, a
       scope the registration never asked for, an administrator who turned IMAP
       off — went unnamed. `result.reconnect` is the flag core/sources/imap.mjs
       sets for "this grant is dead and retrying will not revive it", which is the
       one case worth telling somebody to do something about. */
    if (oauth) {
      return check(
        id, label, 'fail',
        `${account.host}: ${reason}`,
        result?.reconnect
          ? 'The Microsoft sign-in for this mailbox is no longer good — a changed password, a revoked consent, a new conditional access policy or 90 days of inactivity all do this. '
            + 'Open Settings → Email, edit this account and press "Sign in with Microsoft" again.'
          : `If this says the server does not offer AUTH=XOAUTH2, the host is wrong — Microsoft's is ${guess.host || 'outlook.office365.com'}:993. `
            + 'If it names a scope, the app registration is missing IMAP.AccessAsUser.All under API permissions. '
            + 'Everything else is worth trying again: an unreachable sign-in endpoint is not a broken account.',
      );
    }
    return check(
      id, label, 'fail',
      `${account.host}: ${reason}`,
      authish
        ? `Most sign-in failures here are not a wrong password — they are a provider that refuses ordinary passwords over IMAP. ${guess.note}`
        : `Check the server and port in Settings → Email (${account.host}:${account.port ?? 993}${account.secure === false ? ', STARTTLS' : ', TLS'}). If they are right, the server may be blocking IMAP for this account — that is a setting in your provider's web mail.`,
    );
  }

  const boxes = result.mailboxes ?? [];
  const names = new Set(boxes.map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean));

  /* The sent folder belongs in `wanted`, and leaving it out is why this check
     could print "pass · 4 folders · reading INBOX" about an account whose every
     sweep was reporting `Mailbox doesn't exist: Sent` forever. core/sweep.mjs's
     `mailboxesFor()` appends `account.sentMailbox` to every fetch, and the
     default is the bare word "Sent" — which is wrong for Gmail
     ("[Gmail]/Sent Mail"), Microsoft 365 ("Sent Items") and iCloud
     ("Sent Messages"), three of the eight providers this app hardcodes and the
     three largest. The list below is built the same way sweep builds it, so the
     two cannot disagree about what is being read. */
  const configured = Array.isArray(account.mailboxes) && account.mailboxes.length ? account.mailboxes : ['INBOX'];
  const sent = typeof account.sentMailbox === 'string' ? account.sentMailbox.trim() : '';
  const wanted = sent && !configured.includes(sent) ? [...configured, sent] : [...configured];

  const missing = wanted.filter((m) => names.size && !names.has(m));
  if (missing.length) {
    // The server's own SPECIAL-USE \Sent flag, which the client already reads
    // and nothing outside a test ever looked at. When the missing folder is the
    // sent one, this turns "pick from these eight names" into the actual answer.
    const flagged = boxes.find((m) => m && typeof m === 'object' && m.specialUse === 'sent')?.name || '';
    const sentIsMissing = Boolean(sent) && missing.includes(sent);
    return check(
      id, label, 'warn',
      `Signed in to ${account.host}, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the server.`,
      sentIsMissing && flagged
        ? `This server calls its sent folder "${flagged}" — put that in Settings → Email → Sent folder. Until then Zelos never reads what you wrote, so "you promised" and half of "waiting on" cannot be built.${missing.length > 1 ? ` The rest: pick from ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}` : ''}`
        : `Zelos will read nothing from ${missing.length === 1 ? 'that folder' : 'those folders'}. Pick from what the server actually has: ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}`,
    );
  }
  /* The method is named on the passing line, not only on the failing ones. This
     whole check exists because a config can say one thing while the sweep does
     another, and "Signed in" without saying HOW is the sentence that let that go
     unnoticed for a release. */
  const signedWith = String(account.oauth?.provider ?? '').toLowerCase() === 'google' ? ' with Google' : ' with Microsoft';
  return check(
    id, label, 'pass',
    `Signed in to ${account.host}${oauth ? signedWith : ''} · ${names.size} folder${names.size === 1 ? '' : 's'} · reading ${wanted.join(', ')}${sent ? '' : ' · no sent folder is set, so nothing you wrote is read'}`,
  );
}

/** Read a fetch Response with a hard byte cap, so a huge .ics cannot OOM us. */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`the calendar is larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The ctx a connector's `check(source, ctx)` is handed.
 *
 * Every network path in it is one of doctor's own `deps`, which is what keeps
 * rule 2 at the top of this file true for connector code as well as for this
 * one: the whole suite runs against a deps object whose every network function
 * throws, so a check that reached past this would be a diagnostic no test could
 * hold still — and, worse, one a user could not predict from their config.
 *
 * `http` is the same origin-pinned transport `collect` gets, built from what the
 * connector declared plus what the USER configured (`originsFor`). A check may
 * therefore contact exactly the addresses the sweep may, and nothing else. It is
 * built rather than lazily created because a connector reading `ctx.http` and
 * finding `undefined` is a crash in a diagnostic, which is the one place a crash
 * is least affordable.
 *
 * `now` and `timezone` are the user's, exactly as core/sweep.mjs hands them to
 * `collect`. They were missing, so the two checks that count "overdue" (Linear,
 * Todoist) fell back to the machine's clock in the machine's zone — the one-day
 * error their sweep paths exist to prevent, printed in the one command a stuck
 * person runs — and a test pinned to a fixed day had no way to hold the clock
 * still.
 */
function checkContext(connector, source, deps, { timeoutMs, signal, secret = null, timezone }) {
  return {
    secret,
    timeoutMs,
    signal,
    now: nowISO(timezone),
    timezone,
    maxBytes: MAX_ICS_BYTES,
    getSecret: deps.getSecret,
    testCalDav: deps.testCalDav,
    testImap: deps.testImap,
    http: createHttp({
      origins: originsFor(connector, source),
      limits: connector.limits,
      credential: connector.credential,
      graphql: connector.graphql === true,
      secret,
      signal,
      timeoutMs,
      fetchImpl: deps.fetchImpl,
    }),
  };
}

async function checkCalendar(calendar, deps, { timeoutMs, signal, timezone }) {
  const name = calendar.label || calendar.url || calendar.id;
  const id = `calendar.${calendar.id}`;
  const label = `Calendar · ${name}`;

  if (!calendar.url) {
    return check(id, label, 'fail', 'This calendar has no address.',
      'Open Settings → Calendars and paste the subscription link (it ends in .ics), the CalDAV server address, or the path to a local file.');
  }

  /* The kind is LOOKED UP, not switched on. This used to be
     `if (calendar.kind === 'file')` and `if (calendar.kind === 'caldav')`, which
     meant every connector anyone ever adds needed an edit here — in a file that
     knows nothing about it — to be diagnosable at all. Both branches now live in
     the connector that owns the protocol, and this is the only line that has to
     know a connector might have a probe. */
  const connector = connectorFor(calendar.kind);
  if (connector?.check) {
    try {
      const verdict = await connector.check(calendar, checkContext(connector, calendar, deps, { timeoutMs, signal, timezone }));
      return check(id, label, verdict?.status ?? 'fail', verdict?.detail ?? '', verdict?.action ?? null);
    } catch (err) {
      /* A check that throws is a bug in a connector, and a bug in a connector
         must not take the whole report down with it: the person running this
         command is already stuck, and "zelos doctor crashed" is the least
         useful thing it could tell them. */
      return check(id, label, 'fail', `${calendar.url}: ${errorText(err)}`,
        'That is a failure inside Zelos rather than in your settings. Check the address in Settings → Calendars, and report this if it keeps happening.');
    }
  }

  /* No probe of its own — so the address is read as a subscribed .ics below.
     That is the same fallback `enabledSources` makes for a calendar kind no
     connector claims (core/connectors/index.mjs), and deliberately so: the two
     are one decision about what an unremarkable calendar address is, and they
     should stay one. */
  // webcal: is how Apple and friends publish an https .ics.
  const url = safeUrl(String(calendar.url).replace(/^webcal:/i, 'https:'));
  if (!url || !/^https?:/i.test(url)) {
    return check(id, label, 'fail', `${calendar.url} is not an http, https or webcal address.`,
      'Open Settings → Calendars and paste the subscription link your calendar provider gives you — it starts with https:// or webcal:// and usually ends in .ics.');
  }

  const headers = { Accept: 'text/calendar, text/plain;q=0.5' };
  try {
    if (calendar.user && calendar.keyRef) {
      const pass = await deps.getSecret(calendar.keyRef);
      if (pass) headers.Authorization = `Basic ${Buffer.from(`${calendar.user}:${pass}`).toString('base64')}`;
    }
  } catch { /* try unauthenticated; the server's answer is the real diagnosis */ }

  try {
    // The caller's signal must not replace the timeout — a calendar host that
    // accepts the connection and then says nothing would hang the diagnosis
    // forever, which is the one thing a diagnostic may never do. One deadline
    // covers both hops, so a redirect cannot buy a second full timeout.
    const deadline = AbortSignal.timeout(timeoutMs);
    const abortOn = signal ? AbortSignal.any([signal, deadline]) : deadline;

    /* One hop, and the credential does not cross an origin.
     *
     * `redirect: 'follow'` handed the policy to fetch, which follows up to
     * twenty. Measured on Node 26.3.0: a 6-origin chain returns 200 having
     * contacted six hosts, and a 22-origin chain contacts twenty-one before
     * giving up — so `zelos doctor` opened connections to as many as twenty
     * hosts the user never typed, inside the same passage of docs/SECURITY.md
     * that invites the reader to check it with tcpdump and promises one hop.
     * core/sweep.mjs's `fetchIcsText` has hand-rolled this rule since the
     * beginning; this call site and the Settings "Test" button were the only
     * two readers in the repo that delegated it. (undici does strip
     * Authorization across origins itself — verified — so no credential leaked;
     * the traffic is the defect, and re-attaching auth on a same-origin hop is
     * this code's own decision rather than a library's.)
     */
    const request = (target, withAuth) => deps.fetchImpl(target, {
      headers: withAuth ? headers : { Accept: headers.Accept },
      redirect: 'manual',
      signal: abortOn,
    });

    let response = await request(url, true);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return check(id, label, 'fail', `${url} answered ${response.status} but did not say where to.`,
          'That is a broken redirect on the calendar host, not a setting here. Open the link in a browser: whatever it shows you is what Zelos is getting.');
      }
      const next = new URL(location, url);
      const sameOrigin = next.origin === new URL(url).origin;
      response = await request(next, sameOrigin);
      if (response.status >= 300 && response.status < 400) {
        return check(id, label, 'fail', `${url} redirects more than once (via ${next.origin}), and Zelos follows exactly one hop.`,
          `Copy the address it ends up at and paste that into Settings → Calendars instead. Zelos will not walk a redirect chain: each extra hop is another host contacting${calendar.user && calendar.keyRef ? ', with your calendar password attached whenever the origin has not changed' : ''}.`);
      }
    }
    if (!response.ok) {
      const advice = response.status === 401 || response.status === 403
        ? 'That link needs credentials, or it has been revoked. Re-copy the subscription link from your calendar provider.'
        : response.status === 404
          ? 'That link no longer exists. Re-copy the subscription link from your calendar provider.'
          : 'Open the link in a browser: whatever it shows you is what Zelos is getting.';
      return check(id, label, 'fail', `${url} answered ${response.status} ${response.statusText}`, advice);
    }
    const parsed = parseICS(await readCapped(response, MAX_ICS_BYTES));
    if (!parsed.vevents.length) {
      return check(id, label, 'warn', `${url} is reachable but has no entries in it.`,
        'That is fine if the calendar really is empty. If it should not be, check you copied the link for the right calendar.');
    }
    return check(id, label, 'pass', `${parsed.calname || url} · ${parsed.vevents.length} entr${parsed.vevents.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    return check(id, label, 'fail', `${url}: ${errorText(err)}`,
      'Check the address in Settings → Calendars, and that this machine can reach it. A subscription link that works in a browser will work here.');
  }
}

/**
 * One entry in `config.sources` — the third place config keeps a source, and
 * until now the one doctor could not see at all.
 *
 * `mail` and `calendars` each have a hand-written check above because each has a
 * hand-written editor and twenty years of provider-specific advice to give. This
 * one has neither and must never grow either: everything it knows about the
 * source comes off the manifest — the label, which settings are required, what
 * the credential is called and where you mint one — so a connector added next
 * month is diagnosed by this function without it being edited.
 *
 * What it does NOT do is guess at the protocol. If the connector declares a
 * `check`, that is the probe; if it does not, this reports what is configured
 * and says plainly that nothing was contacted. A `pass` that means "I did not
 * look" would be the exact failure the database check at the top of this file
 * exists because of.
 */
async function checkSource(source, deps, { timeoutMs, signal, timezone }) {
  const connector = connectorFor(source.type);
  const name = source.label || source.id;
  const id = `source.${source.id}`;
  const label = `${connector.label} · ${name}`;
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};

  const missing = (connector.fields ?? []).filter((f) => f.required
    && String(settings[f.name] ?? '').trim() === '');
  if (missing.length) {
    const names = missing.map((f) => `“${f.label}”`).join(', ');
    return check(
      id, label, 'fail',
      `${name} has no ${missing.map((f) => f.label.toLowerCase()).join(', ')} yet, so there is nothing for Zelos to read.`,
      `Open Settings → Other things it can read, edit ${name}, and fill in ${names}.`,
    );
  }

  let secret = null;
  if (connector.credential && source.keyRef) {
    try {
      secret = await deps.getSecret(source.keyRef);
    } catch (err) {
      return check(id, label, 'fail', `Zelos could not read the stored credential for ${name}: ${errorText(err)}`,
        'See the secret store line above — that is where this failed. Re-entering it in Settings → Other things it can read usually settles it.');
    }
  }
  /* `credential: null` and `{required: false}` are different facts and this is
     one of the two places that has to keep them apart — see core/connectors/
     file.mjs. A source with nothing to paste must never be told something is
     missing. */
  if (connector.credential?.required && !secret) {
    const what = connector.credential.label;
    const mint = connector.credential.url ? ` You create one at ${connector.credential.url}.` : '';
    return check(
      id, label, 'fail',
      `No ${what.toLowerCase()} is stored for ${name}, so Zelos cannot read it.`,
      `Open Settings → Other things it can read and paste it. ${connector.credential.help || ''}${mint}`.trim(),
    );
  }

  if (!connector.check) {
    const where = (connector.fields ?? []).find((f) => f.type === 'url' && settings[f.name]);
    return check(
      id, label, 'pass',
      `Configured${where ? ` · ${settings[where.name]}` : ''} · read on the next sweep. Nothing was contacted: this source offers no test of its own.`,
    );
  }

  try {
    const verdict = await connector.check(source, checkContext(connector, source, deps, { timeoutMs, signal, secret, timezone }));
    return check(id, label, verdict?.status ?? 'fail', verdict?.detail ?? '', verdict?.action ?? null);
  } catch (err) {
    return check(id, label, 'fail', `${name}: ${errorText(err)}`,
      'That is a failure inside Zelos rather than in your settings. Check this source in Settings → Other things it can read, and report it if it keeps happening.');
  }
}

/**
 * The entries config holds that name no connector at all.
 *
 * `unknownSources()` has existed since the registry landed and had no reader
 * outside the tests, which is why a hand-edited `"type": "runes"` used to be a
 * source that appears in Settings, contributes nothing, and has nothing anywhere
 * saying why. This is that reader.
 *
 * The two halves are different faults and get different statuses. A `sources[]`
 * entry naming nothing is read by NOTHING — `enabledSources` drops it — so it is
 * broken, and doctor's exit code should say so. A `calendars[]` entry with an
 * unrecognised kind is still read, as a subscribed .ics, so it is worth knowing
 * rather than broken; `validateConfig` also rejects that kind, so this line is a
 * second and plainer voice on the same fact rather than the only one.
 *
 * Disabled entries are skipped. A source switched off is contributing nothing on
 * purpose, and a diagnostic that complains about it is a diagnostic people learn
 * to ignore.
 */
function checkUnknownSources(cfg) {
  const unknown = unknownSources(cfg).filter((u) => u.source?.enabled !== false);
  if (!unknown.length) return null;

  const named = unknown.map((u) => {
    const what = u.source?.label || u.id || '(no id)';
    return `${what} (${u.at === 'calendars' ? 'calendar' : 'source'} ${u.id || '?'}) names the kind “${u.type || '(blank)'}”`;
  });
  const anySource = unknown.some((u) => u.at === 'sources');
  return check(
    'sources.unknown', 'Unrecognised', anySource ? 'fail' : 'warn',
    `${named.join('; ')} — ${unknown.length === 1 ? 'and no connector in this build claims it' : 'and no connector in this build claims them'}.`,
    anySource
      ? 'Nothing reads a source whose type Zelos does not know, so it contributes nothing to the board and never will. Fix the type in Settings, or delete the entry. If it is a source a newer Zelos supports, update Zelos.'
      : 'Zelos reads it as a subscribed .ics anyway, which is what it did before it kept a list of kinds — so it may well be working. Set the kind in Settings → Calendars to be sure of what is being read.',
  );
}

/* ------------------------------------------------------------------ *
 * diagnose
 * ------------------------------------------------------------------ */

/**
 * Run every check.
 *
 * -> {ok, status, checks:[{id,label,status,detail,action}], counts, home, node, ms}
 *
 * `ok` is true only when nothing failed. Warnings do not make it false: "you
 * have not connected mail yet" is a fact about a new install, not a fault.
 */
export async function diagnose(options = {}) {
  const home = homeDirPath();
  /* The folder is looked at before anything touches it: the maintenance check
     reads a file inside it (and threw ENOTDIR on a home that is a file), and
     the lease and paths() below create things in it. A home that is missing
     or unusable is reported, and nothing else is run — with no folder there
     are no settings to check, and the report says how to make one (TT-3484). */
  const homeCheck = checkHome(home);
  // (A caller that hands doctor its config has something to check without a
  // folder, and is let through — only the tests do; `zelos doctor` passes none.)
  if (homeCheck.status === 'fail' || (!fs.existsSync(home) && !options.config)) {
    const checks = [checkNode(), homeCheck];
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const item of checks) counts[item.status]++;
    const failed = counts.fail > 0;
    return { ok: !failed, ready: false, status: failed ? 'fail' : 'warn', checks, counts, home, node: process.versions.node, ranAt: new Date().toISOString(), ms: 0 };
  }
  assertNoMaintenance(home);
  // Doctor opens SQLite directly and can refresh OAuth credentials while
  // testing a mailbox. Its whole diagnostic lifetime must exclude restore.
  const lease = registerDataConnection(path.join(home, 'zelos.db'));
  try { return await diagnoseUnlocked(options, homeCheck); } finally { lease.release(); }
}

async function diagnoseUnlocked({ config = null, timeoutMs = 10_000, signal, deps = {} } = {}, homeCheck) {
  const startedMs = Date.now();
  const d = { ...DEFAULT_DEPS, ...deps };
  // Mail, calendars and sources read their own secrets through this; the AI key
  // is read only by checkModelKey, for the AI's own address. A `model.` ref in
  // their config gets nothing, rather than the key to try against their host.
  const own = { ...d, getSecret: async (ref) => (isModelKeyRef(ref) ? null : d.getSecret(ref)) };
  const checks = [];

  // Before anything resolves paths(): that call creates and chmods the folder.
  const home = homeDirPath();
  checks.push(checkNode());
  checks.push(homeCheck);
  checks.push(checkDatabase(home));

  let cfg = config;
  let loadError = null;
  let configFile = path.join(home, 'config.json');
  try {
    /* Parsed here, read-only, before loadConfig: that call moves an
       unparseable config.json aside and carries on with the defaults, so a
       hand-broken file was renamed by the check meant to report it, and then
       reported as "No settings file has been written yet… Nothing to do",
       with exit 0 (TT-3484). */
    if (!cfg) {
      let text = null;
      try { text = fs.readFileSync(configFile, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
      if (text !== null) {
        let parsed;
        try { parsed = JSON.parse(text); } catch (err) { throw new Error(`config.json is not valid JSON (${err.message})`); }
        // loadConfig reads anything but an object as {} without a word, so
        // `[]` or `"x"` would throw every setting away and pass as "valid".
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`config.json is not a JSON object (it holds ${parsed === null ? 'null' : Array.isArray(parsed) ? 'a list' : `a ${typeof parsed}`})`);
        }
      }
    }
    const where = paths();
    configFile = where.configFile;
    if (!cfg) cfg = loadConfig();
  } catch (err) {
    loadError = errorText(err);
    // Back to what the caller gave (usually nothing), so the AI and mail
    // checks below are skipped rather than run against a half-read config.
    cfg = config;
  }
  checks.push(checkConfig(cfg, configFile, loadError));

  checks.push(await checkSecrets(d, home));

  if (cfg) {
    const { result: keyCheck, key } = await checkModelKey(cfg, d);
    checks.push(keyCheck);
    checks.push(await checkModelEndpoint(cfg, d, {
      key,
      keyChecked: keyCheck.status === 'pass',
      timeoutMs,
      signal,
    }));

    const mail = (Array.isArray(cfg.mail) ? cfg.mail : []).filter((a) => a && a.enabled);
    if (!mail.length) {
      checks.push(check(
        'mail', 'Mail', 'warn',
        'No mail account is switched on.',
        'Open Settings → Email to add one. Zelos reads over IMAP with BODY.PEEK, so nothing is marked as read, and it never sends.',
      ));
    } else {
      // One at a time: several TLS logins to the same provider at once is how a
      // diagnostic gets itself rate-limited.
      for (const account of mail) {
        checks.push(await checkMailAccount(account, own, { timeoutMs }));
      }
    }

    /* The user's zone, resolved the way core/sweep.mjs `timezoneOf` resolves
       it, so a connector's check counts "overdue" on the same day the sweep
       will. `config` may have arrived here unnormalised (DEFAULTS carries an
       empty string, and `nowISO('')` quietly reads as UTC), hence the fallback
       rather than the raw field. */
    const rawTz = cfg.identity?.timezone;
    const timezone = typeof rawTz === 'string' && rawTz.trim() ? rawTz : localTimezone();

    const calendars = (Array.isArray(cfg.calendars) ? cfg.calendars : []).filter((c) => c && c.enabled);
    if (!calendars.length) {
      checks.push(check(
        'calendar', 'Calendars', 'warn',
        'No calendar is switched on.',
        'Open Settings → Calendars and paste a subscription link (.ics), a CalDAV address, or the path to a local file. Zelos only ever reads.',
      ));
    } else {
      for (const calendar of calendars) {
        checks.push(await checkCalendar(calendar, own, { timeoutMs, signal, timezone }));
      }
    }

    /* `sources` gets no "you have not added one" warning, and mail and calendars
       do. That is not an oversight: an install with neither mail nor a calendar
       cannot do its job, which is a fact worth a line on a new machine, while an
       install with no feeds is the ordinary case and a third "nothing here yet"
       line would be noise on every single run. Only entries that name a
       connector are checked; the ones that do not are the report below. */
    for (const source of (Array.isArray(cfg.sources) ? cfg.sources : [])) {
      if (!source?.enabled || !connectorFor(source.type)) continue;
      checks.push(await checkSource(source, own, { timeoutMs, signal, timezone }));
    }

    const unknown = checkUnknownSources(cfg);
    if (unknown) checks.push(unknown);
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;

  /* `ok` and `ready` are two different questions, and conflating them would
     make one of them useless. `ok` is "nothing is broken" — it is what the exit
     code reports, so a fresh install that has simply not been set up yet does
     not look like a fault. `ready` is "Zelos can actually do its job": a model
     to think with, and at least one source to think about. */
  /* Counted by asking the registry, not by adding up two of the three places
     config keeps a source. The old sum was `mail` plus `calendars`, written
     before `sources` existed — so an install whose only source was a feed was
     told it was not ready, and the ! lines it was sent to look at were about
     mail it had deliberately not connected. `enabledSources` is the same
     function the sweep reads, so "ready" and "will actually fetch something"
     cannot drift apart. */
  const sources = enabledSources(cfg).length;
  const ready = counts.fail === 0 && Boolean(String(cfg?.model?.model ?? '').trim()) && sources > 0;

  return {
    ok: counts.fail === 0,
    ready,
    status: counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass',
    checks,
    counts,
    home,
    node: process.versions.node,
    ranAt: new Date().toISOString(),
    ms: Date.now() - startedMs,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const MARKS = { pass: '✓', warn: '!', fail: '✕', skip: '·' };
const RULE = '━'.repeat(58);

/** Greedy wrap that never breaks a word, so a path stays copy-pasteable. */
function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`);
}

/** The terminal report. Same findings as the JSON, in sentences. */
export function formatReport(report, { width = 76 } = {}) {
  const out = ['', '  ZELOS DOCTOR', `  ${RULE}`, ''];

  const labelWidth = Math.max(...report.checks.map((c) => c.label.length), 12);
  const detailIndent = ' '.repeat(2 + 1 + 2 + labelWidth + 2);
  const actionIndent = '       ';

  for (const c of report.checks) {
    const head = `  ${MARKS[c.status] ?? '·'}  ${c.label.padEnd(labelWidth)}  `;
    const detail = wrap(c.detail, Math.max(24, width - detailIndent.length), detailIndent);
    out.push(`${head}${(detail[0] ?? '').trimStart()}`);
    out.push(...detail.slice(1));
    if (c.action) {
      // The arrow marks the sentence that tells you what to do next.
      const action = wrap(c.action, Math.max(28, width - actionIndent.length - 3), `${actionIndent}   `);
      out.push(`${actionIndent}→  ${(action[0] ?? '').trimStart()}`);
      out.push(...action.slice(1));
    }
    out.push('');
  }

  out.push(`  ${RULE}`);
  const { pass, warn, fail, skip } = report.counts;
  const parts = [`${pass} fine`];
  if (warn) parts.push(`${warn} worth knowing`);
  if (fail) parts.push(`${fail} broken`);
  if (skip) parts.push(`${skip} not checked`);
  out.push(`  ${parts.join(' · ')}`);
  if (fail) {
    out.push('  Fix the lines marked ✕ — each one says what to do — then run zelos doctor again.');
  } else if (!report.ready) {
    out.push('  Nothing is broken. Zelos is not finished being set up yet: the ! lines');
    out.push('  are what is left, and each one says where to do it.');
  } else if (warn) {
    out.push('  Nothing is broken. The ! lines are things worth knowing about.');
  } else {
    out.push('  Everything checks out.');
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

/**
 * One call for the launcher: run the checks, render them, hand back the exit
 * code. Non-zero means something is genuinely wrong, never merely unfinished.
 */
export async function doctor(options = {}) {
  const report = await diagnose(options);
  return { code: report.ok ? 0 : 1, report, text: formatReport(report) };
}
