/**
 * core/config.mjs — where Zelos lives on disk, and what it believes.
 *
 * Two rules govern this file:
 *
 *  1. config.json NEVER contains a secret. It carries `keyRef` strings that name
 *     an entry in the secret store (core/secrets.mjs) and nothing else. Anything
 *     that looks like a credential is stripped on the way in, loudly.
 *  2. A save is atomic. Config is written to a temp file in the same directory,
 *     fsync'd, chmod'd 0600, and then renamed over the target. rename(2) on the
 *     same filesystem is atomic, so a crash mid-save leaves the old config
 *     intact — never a half-written one that refuses to parse on next launch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { localTimezone } from './time.mjs';
import { log } from './log.mjs';
import { modelKeyRef, isModelKeyRef } from './model-key.mjs';

/**
 * Keys whose value is a credential. Never written to config.json.
 *
 * Exported for core/connectors/index.mjs, which refuses a connector declaring a
 * settings field by any of these names. `stripSecrets` deletes them anywhere at
 * any depth on every save, so such a field could never be stored — it would
 * vanish on save with a warning that reads like a false positive. The export is
 * one-way on purpose: config.mjs must never import the registry (core/sources/
 * caldav.mjs imports this file, so the reverse edge would be a cycle).
 */
export const SECRET_KEYS = new Set([
  'pass', 'password', 'passwd', 'apikey', 'api_key', 'key', 'token', 'secret', 'credentials',
  /* The XOAUTH2 grant, in both spellings it exists in.
     `refreshToken` is the one that matters and it is not covered by `token`:
     `stripSecrets` matches a WHOLE key name, lowercased, so `token` catches
     `token` and `Token` and nothing else — `refreshToken` lowercases to
     `refreshtoken`, which was not in this set, so a hand-edited or
     mis-patched `mail[i].oauth.refreshToken` would have been written to
     config.json in the clear and stayed there. That token is the whole mailbox
     and it does not expire for 90 days. The snake_case spellings are here
     because they are what Microsoft's token endpoint answers with, so a patch
     that assigned a raw response object would carry those and not the
     camelCase ones. `clientSecret` is a Google client's, and it lives in the
     secret store under a ref (core/sources/oauth.mjs GOOGLE_CLIENT_SECRET_REF)
     — a config carrying the value itself is a mistake worth swallowing rather
     than storing. */
  'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'clientsecret', 'client_secret', 'devicecode', 'device_code',
]);

const PROTOCOLS = ['anthropic', 'openai'];
const CALENDAR_KINDS = ['ics', 'caldav', 'file'];

/**
 * How a mail account signs in.
 *
 * `password` is a password or an app password over `LOGIN`/`AUTHENTICATE PLAIN`.
 * `xoauth2` is a bearer token over `AUTHENTICATE XOAUTH2`, minted from a grant
 * the user gave in their browser: Microsoft's device code (core/sources/imap.mjs
 * §6) or Google's PKCE redirect (core/sources/oauth.mjs, received by
 * core/server.mjs). Which one is `oauth.provider` on the account; the client it
 * ran against is whatever `oauthClient()` found — Zelos's own once it ships
 * one, the operator's from `oauth.clients` until then.
 *
 * An account written before this key existed has no `auth` at all, and that is
 * read as `password`: it is what those accounts have always done.
 */
export const MAIL_AUTH_METHODS = Object.freeze(['password', 'xoauth2']);

/**
 * The two browser sign-ins `mail[i].oauth.provider` can name. Absent reads as
 * `microsoft`, because every account connected before the field existed was.
 */
export const MAIL_OAUTH_PROVIDERS = Object.freeze(['google', 'microsoft']);
/* One theme (black). The only appearance choice is the accent, and it is
   validated as a six-digit hex because it is written straight into a CSS
   custom property — anything else must never reach the stylesheet. */
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Refs are opaque handles ("model.default", "mail.m_9f3a1c"). They end up as a
 *  keychain account name and as a filename, so the charset is deliberately tight. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export function isValidRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 64 && REF_RE.test(ref);
}

/**
 * Defaults for one mail account. Exported so the UI can build a blank one.
 *
 * `requireTls` is deliberately three-valued. `secure: true` is implicit TLS on
 * 993 and needs no help; `secure: false` starts in the clear and upgrades only
 * if the server offers STARTTLS, which a machine in the middle can simply
 * decline to advertise. `requireTls` is the standing instruction about that:
 * `true` means never send the password over an unencrypted socket, `false`
 * means the plaintext is deliberate, and `null` — which is what every config
 * written before this existed says — means decide from the host, requiring it
 * everywhere except loopback. Loopback is where local mail bridges live, and
 * traffic there never leaves the machine, which is the whole reason plaintext
 * is still an option.
 *
 * It is stored as null rather than resolved to a boolean on the way in on
 * purpose: a resolved `false` would survive the user later pointing the same
 * account at a real mail server, and go on permitting cleartext for a host
 * nobody ever meant it for.
 */
export const MAIL_ACCOUNT_DEFAULTS = deepFreeze({
  id: '',
  enabled: true,
  label: '',
  host: '',
  port: 993,
  secure: true,
  requireTls: null,
  user: '',
  /* See MAIL_AUTH_METHODS. Defaulted rather than left absent so `normalizeAccounts`
     gives every account the full shape and no reader has to spell `?? 'password'`
     for itself — there are four of them (the sweep's connector, the doctor, the
     test route and the Settings form) and a default restated four times is a
     default three of them can get wrong. */
  auth: 'password',
  /* `{clientId, tenantId}` from the user's own Entra app registration, or null.
     The GRANT is not here and must never be: it lives in the secret store under
     this account's own `keyRef`, which is why removing an account removes the
     refresh token with it. See SECRET_KEYS. */
  oauth: null,
  keyRef: '',
  mailboxes: ['INBOX'],
  sentMailbox: 'Sent',
  lookbackDays: 14,
  maxMessages: 400,
});

/** Defaults for one calendar. Exported so the UI can build a blank one. */
export const CALENDAR_DEFAULTS = deepFreeze({
  id: '',
  enabled: true,
  label: '',
  kind: 'ics',
  url: '',
  user: '',
  keyRef: null,
});

/**
 * Defaults for one source that is neither mail nor a calendar.
 *
 * `settings` is the only untyped part of the config, and it is untyped here on
 * purpose: what belongs in it is declared by the connector's `fields[]`, which
 * the registry validates, not this file. config.mjs validates the ENVELOPE and
 * the registry validates the PAYLOAD — a split forced by the fact that
 * core/sources/caldav.mjs imports this module, so importing the registry back
 * would be a cycle one eager `paths()` away from a TDZ crash at launch.
 *
 * The practical consequence is that a hand-edited `"type": "runes"` loads, the
 * sweep reports that source unread, and `zelos doctor` names it — which is
 * strictly better than refusing to load, and is the policy this file already
 * argues for where a malformed section is repaired rather than rejected.
 */
export const SOURCE_DEFAULTS = deepFreeze({
  id: '',
  enabled: true,
  label: '',
  type: '',
  keyRef: null,
  settings: {},
});

/**
 * The ranges validateConfig holds the privacy numbers to. Settings → Privacy
 * (ui/views/settings.js) keeps its own copy, since the page cannot import
 * core/; test/ui.test.mjs checks the two agree.
 */
export const PRIVACY_RANGES = deepFreeze({ bodyChars: [200, 100_000], maxItemsPerSweep: [1, 1000] });

/** The range validateConfig holds sweep.intervalMinutes to; Settings → Schedule keeps a copy (TT-3489). */
export const SWEEP_INTERVAL_RANGE = deepFreeze([5, 1440]);

/** The most private reading of the privacy settings: what an unusable value means. */
export const PRIVACY_CLOSED = deepFreeze({ sendBodies: false, bodyChars: 0, maxItemsPerSweep: 1 });

export const DEFAULTS = deepFreeze({
  version: 1,
  identity: { name: '', email: '', timezone: '' },
  model: {
    protocol: 'anthropic',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    keyRef: null,
    maxTokens: 8192,
    temperature: 0,
  },
  mail: [],
  calendars: [],
  sources: [],
  sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true },
  ui: { accent: '#5b8cff' },
  privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
});

/* ------------------------------------------------------------------ paths */

/**
 * The literal strings "undefined" and "null" are treated as no override at
 * all. They are what an undefined JavaScript value becomes when a launcher
 * interpolates it into an environment variable (`ZELOS_HOME=${home}` with
 * `home` unset), and honouring them once put a live data directory named
 * `undefined/` in the current working directory. Garbage that specific is
 * worth naming rather than resolving.
 */
function homeDir() {
  const override = process.env.ZELOS_HOME;
  const trimmed = override ? override.trim() : '';
  const garbage = trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null';
  return trimmed && !garbage ? path.resolve(override) : path.join(os.homedir(), '.zelos');
}

/**
 * mkdir -p at 0700. mkdir's `mode` is masked by the process umask, and an
 * already-existing directory keeps whatever mode it had, so tighten explicitly
 * afterwards — this directory holds the database and, on the fallback backend,
 * the encrypted secret store.
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode & 0o077) fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new Error(`cannot create Zelos directory ${dir}: ${err.message}`);
  }
}

export function paths() {
  const home = homeDir();
  const logsDir = path.join(home, 'logs');
  const cacheDir = path.join(home, 'cache');
  ensureDir(home);
  ensureDir(logsDir);
  ensureDir(cacheDir);
  return {
    home,
    db: path.join(home, 'zelos.db'),
    configFile: path.join(home, 'config.json'),
    logsDir,
    cacheDir,
  };
}

/* ------------------------------------------------------------------ merge */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge. Objects merge key-by-key; arrays REPLACE wholesale — merging
 * `mail` element-by-element would make it impossible to remove an account.
 * `undefined` in the patch means "leave alone"; `null` means "set to null"
 * (calendars legitimately carry `keyRef: null`).
 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Remove anything credential-shaped, anywhere in the tree, and say so. This is
 * the last line of defence for rule 1: even if a route or a UI form hands us a
 * password, it does not reach the disk.
 */
function stripSecrets(value, at = '', found = []) {
  if (Array.isArray(value)) return value.map((v, i) => stripSecrets(v, `${at}[${i}]`, found));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const where = at ? `${at}.${k}` : k;
    if (SECRET_KEYS.has(k.toLowerCase())) {
      found.push(where);
      continue;
    }
    out[k] = stripSecrets(v, where, found);
  }
  if (!at && found.length) {
    log.warn('config: refused to store credential fields', { paths: found });
  }
  return out;
}

/* ------------------------------------------------------------------ ids */

/** e.g. newId('m') -> 'm_9f3a1c' */
export function newId(prefix) {
  const p = String(prefix ?? '').trim();
  if (!/^[a-z]{1,8}$/.test(p)) throw new TypeError(`newId: prefix must be 1-8 lowercase letters, got ${JSON.stringify(prefix)}`);
  return `${p}_${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------------------ shape */

/**
 * The five sections whose value has to BE an object for the rest of the program
 * to read the config at all. `loadConfig` dereferences `identity.timezone` on
 * its last line, and zelos.mjs, the server and the UI go straight at `model.*`,
 * `sweep.*`, `ui.accent` and `privacy.*` the moment they have a config in hand.
 *
 * `deepMerge` lets a scalar replace an object on purpose — that is how a patch
 * sets a `keyRef` to null — so `{"identity": 5}` merges cleanly, serialises
 * cleanly, and then kills the next launch with a raw stack trace before
 * `validateConfig` ever gets to say "identity must be an object". `5`, `"Nemo"`,
 * `false` and `null` all do it: under strict mode the assignment to a primitive
 * throws just as the dereference of null does.
 *
 * Both halves of that are handled, and deliberately not in the same direction:
 *
 *  - a SAVE that would produce one is refused before anything reaches the disk,
 *    because the caller is sending nonsense and should be told so;
 *  - a FILE that already holds one is repaired on the way in, because
 *    `zelos doctor` tells the user to edit config.json by hand and a typo there
 *    must not brick the app that is supposed to report the typo.
 *
 * `mail`, `calendars` and `sources` need no entry here: `normalizeAccounts`
 * already replaces a non-array with an empty one. That is the right repair for
 * a FILE and the wrong one for a PATCH — see ACCOUNT_LISTS.
 */
const SECTIONS = ['identity', 'model', 'sweep', 'ui', 'privacy'];

/**
 * The three sections that hold a list of accounts. A patch naming one of them
 * must carry an array of objects, and is refused otherwise — the same rule
 * SECTIONS applies to the object sections, for the same reason, and it was
 * missing here because `normalizeAccounts` made the nonsense disappear instead
 * of surfacing it: `{"mail": "nope"}` (or null, or `{}`) merged over the file,
 * normalised to `mail: []`, and was written with a 200 and `errors: []`. Every
 * configured account was gone, the secrets that belonged to them were left
 * orphaned in the store, and the only thing the caller was told was "Saved."
 *
 * `loadConfig` keeps coercing, because a hand-edited file must still load.
 */
const ACCOUNT_LISTS = ['mail', 'calendars', 'sources'];

/** Which of the five sections are not objects. Names only — never values. */
function malformedSections(cfg) {
  return SECTIONS.filter((key) => !isPlainObject(cfg[key]));
}

/* ------------------------------------------------------------------ load */

function readRaw(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('config: unreadable, using defaults', { error: err.message });
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    // A config we cannot parse is a config somebody will want to look at.
    // Move it aside rather than overwriting it on the next save.
    const aside = `${configFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(configFile, aside);
      log.warn('config: unparseable, moved aside', { aside, error: err.message });
    } catch {
      log.warn('config: unparseable and could not be moved aside', { error: err.message });
    }
    return {};
  }
}

/** Give every account the full shape and a stable id, so callers never guess. */
function normalizeAccounts(cfg) {
  cfg.mail = (Array.isArray(cfg.mail) ? cfg.mail : [])
    .filter(isPlainObject)
    .map((a) => {
      const acct = deepMerge(structuredClone(MAIL_ACCOUNT_DEFAULTS), a);
      if (!acct.id) acct.id = newId('m');
      if (!acct.keyRef) acct.keyRef = `mail.${acct.id}`;
      if (!Array.isArray(acct.mailboxes) || acct.mailboxes.length === 0) acct.mailboxes = ['INBOX'];
      return acct;
    });
  cfg.calendars = (Array.isArray(cfg.calendars) ? cfg.calendars : [])
    .filter(isPlainObject)
    .map((c) => {
      const cal = deepMerge(structuredClone(CALENDAR_DEFAULTS), c);
      if (!cal.id) cal.id = newId('c');
      return cal;
    });
  /* The keyRef is minted here for a source and NOT for a calendar, which looks
     inconsistent and is not: mail has always had one minted (`mail.${id}`
     above) and the calendar editor mints `calendar.${id}` in the UI, so both
     arrive with one already. Minting a calendar's here would make the sweep
     look up a secret for calendars saved before the UI did that — a lookup that
     does not happen today. `${type}.${id}` matches both existing shapes, and
     nothing may ever REQUIRE it: a source whose connector declares no
     credential never needs one. */
  cfg.sources = (Array.isArray(cfg.sources) ? cfg.sources : [])
    .filter(isPlainObject)
    .map((s) => {
      const src = deepMerge(structuredClone(SOURCE_DEFAULTS), s);
      if (!src.id) src.id = newId('s');
      if (!isPlainObject(src.settings)) src.settings = {};
      if (!src.keyRef && src.type) src.keyRef = `${src.type}.${src.id}`;
      return src;
    });
  /* The model's keyRef is the ref core/model-key.mjs derives from its address,
     written down so a version from before keys were kept per address can still
     find the key. Nothing in this version reads a key through it. */
  if (isPlainObject(cfg.model)) cfg.model.keyRef = modelKeyRef(cfg.model.baseUrl);
  return cfg;
}

export function loadConfig() {
  const { configFile } = paths();
  const cfg = normalizeAccounts(deepMerge(structuredClone(DEFAULTS), stripSecrets(readRaw(configFile))));
  // A section somebody hand-edited into a scalar is put back before anything
  // reads through it. Loud, because the values in it are gone: this is the one
  // place that notices, and the alternative was a stack trace at launch.
  for (const key of malformedSections(cfg)) {
    log.warn('config: section is not an object, using its defaults', {
      section: key,
      found: cfg[key] === null ? 'null' : typeof cfg[key],
    });
    /* Privacy is put back CLOSED, not to its defaults: the defaults send
       bodies, and a section nobody can read says nothing about whether its
       owner wanted that. The closed values fail validateConfig, so Settings
       names the section until it is saved again (TT-3424). */
    cfg[key] = structuredClone(key === 'privacy' ? PRIVACY_CLOSED : DEFAULTS[key]);
  }
  // Resolved at read time, not persisted: a machine that moves should follow.
  if (!cfg.identity.timezone) cfg.identity.timezone = localTimezone();
  return cfg;
}

/* ------------------------------------------------------------------ save */

/**
 * Atomic write: temp file in the SAME directory (rename is only atomic within a
 * filesystem), fsync the contents, chmod explicitly (umask can widen the mode
 * passed to open), rename over the target, then fsync the directory so the
 * rename itself is durable.
 */
export function writeFileAtomic(file, contents, mode = 0o600) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Some platforms refuse to fsync a directory. The rename already happened.
  }
}

export function saveConfig(patch = {}) {
  // Checked before paths() so a caller that hands over a scalar or an array
  // does not even create the directory: `deepMerge` would return that value as
  // the whole config, and the first thing to touch it would throw from
  // somewhere further in with no clue whose fault it was.
  if (!isPlainObject(patch)) {
    throw new TypeError(`saveConfig: patch must be an object, got ${patch === null ? 'null' : typeof patch}`);
  }
  // Checked on the PATCH, before the merge, because after it there is nothing
  // left to check: `normalizeAccounts` would have turned the nonsense into an
  // empty list that loads back perfectly. See ACCOUNT_LISTS.
  for (const key of ACCOUNT_LISTS) {
    if (!Object.hasOwn(patch, key)) continue;
    if (!Array.isArray(patch[key]) || patch[key].some((entry) => !isPlainObject(entry))) {
      throw new TypeError(`config: ${key} must be an array of objects — nothing was written`);
    }
  }
  const { configFile } = paths();
  // Merge over what is ON DISK, not over the resolved config, so runtime-filled
  // values (a timezone inferred from Intl) never get frozen into the file.
  const raw = stripSecrets(readRaw(configFile));
  // A section the FILE already got wrong is dropped rather than merged, so the
  // DEFAULTS underneath show through and this save quietly repairs it. Refusing
  // on it instead would leave a hand-edited typo blocking every later save —
  // including the one the user makes in Settings to correct it.
  for (const key of SECTIONS) {
    if (!Object.hasOwn(raw, key) || isPlainObject(raw[key])) continue;
    log.warn('config: dropping a malformed section from the file on disk', { section: key });
    // Privacy is repaired closed, as loadConfig repairs it: dropping it would
    // let the defaults, which send bodies, show through (TT-3424).
    if (key === 'privacy') raw[key] = structuredClone(PRIVACY_CLOSED);
    else delete raw[key];
  }
  const merged = normalizeAccounts(
    deepMerge(deepMerge(structuredClone(DEFAULTS), raw), stripSecrets(patch)),
  );
  // Anything still malformed came from the PATCH, so refuse it here — before
  // the write, not after. This used to persist first and only find out on the
  // last line, when its own loadConfig() threw: the caller got a 500, the
  // running process kept serving its in-memory snapshot as if nothing had
  // happened, and config.json was left holding a value no later launch could
  // read. A save that cannot be loaded back is not a save.
  const broken = malformedSections(merged);
  if (broken.length) {
    throw new TypeError(`config: ${broken.join(', ')} must be ${broken.length > 1 ? 'objects' : 'an object'} — nothing was written`);
  }
  writeFileAtomic(configFile, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return loadConfig();
}

/* ------------------------------------------------------------------ validate */

const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function checkUrl(errors, at, value, { schemes, required }) {
  if (!isStr(value) || !value.trim()) {
    if (required) errors.push({ path: at, message: 'is required' });
    return;
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    errors.push({ path: at, message: `is not a valid URL: ${value}` });
    return;
  }
  if (!schemes.includes(u.protocol)) {
    errors.push({ path: at, message: `must use ${schemes.join(' or ')} (got ${u.protocol})` });
  }
}

/**
 * Microsoft's two identifiers, restated here rather than imported.
 *
 * core/sources/imap.mjs already owns `normalizeClientId` and `normalizeTenant`
 * and they are the authority — but they THROW an `ImapOAuthError` on a bad
 * value, and this function's whole contract is to collect `{path, message}` and
 * never throw. Wrapping them in try/catch here would also make config.mjs
 * import 2,500 lines of TLS and socket code, in the one module that resolves the
 * home directory and that core/sources/caldav.mjs imports back — the same
 * hazard core/connectors/index.mjs writes out at length for the registry.
 *
 * So the pattern is CALENDAR_KINDS's: state it twice, and let a cross-check test
 * fail if the two ever disagree. test/mail-oauth.test.mjs drives both over a
 * corpus of GUIDs, domains, aliases and the `..` that started all this.
 *
 * The tenant is checked at all — rather than passed through as a string —
 * because it becomes a URL PATH SEGMENT at the token endpoint, and a tenant of
 * `..` silently resolves `${origin}/${tenant}/oauth2/v2.0/token` to somewhere
 * else on the same host. What goes to that address is the refresh token.
 */
const ENTRA_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const TENANT_ALIASES = ['common', 'organizations', 'consumers'];

/** True for every tenant core/sources/imap.mjs's `normalizeTenant` accepts. */
export function isValidTenant(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return true; // absent means `common`, which is the default there too
  const lower = raw.toLowerCase();
  return TENANT_ALIASES.includes(lower) || ENTRA_GUID_RE.test(raw) || ENTRA_DOMAIN_RE.test(raw);
}

/** True for the one shape Entra hands out as an application (client) ID. */
export function isValidClientId(value) {
  return typeof value === 'string' && ENTRA_GUID_RE.test(value.trim());
}

/**
 * True for what core/sources/imap.mjs's `normalizeGoogleClientId` accepts: one
 * token, no whitespace, not absurdly long. Google's ids end in
 * `.apps.googleusercontent.com` today; that suffix is not pinned, for the
 * reason given there.
 */
export function isValidGoogleClientId(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  return raw.length > 0 && raw.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(raw);
}

/**
 * The `oauth` block on one mail account.
 *
 * PRESENCE is required only for an enabled account, the way `host` and `user`
 * already are: an account somebody parked half-configured must not block every
 * later save, including the one that finishes it. SHAPE is checked whenever
 * there is something to check, enabled or not, because a malformed block is a
 * typo either way and this is the only screen that will ever say so.
 */
function checkMailOAuth(errors, at, account, { method, enabled }) {
  const block = account.oauth;
  if (method !== 'xoauth2') {
    if (block !== null && block !== undefined && !isPlainObject(block)) {
      errors.push({ path: `${at}.oauth`, message: 'must be an object or null' });
    }
    return;
  }
  if (!isPlainObject(block)) {
    if (enabled) {
      errors.push({
        path: `${at}.oauth`,
        message: 'is required when auth is xoauth2 — it holds the application (client) ID and '
          + 'directory (tenant) ID of the app registration you made in your own Microsoft account',
      });
    } else if (block !== null && block !== undefined) {
      errors.push({ path: `${at}.oauth`, message: 'must be an object or null' });
    }
    return;
  }
  /* Absent is Microsoft, not an error: the field was added after the first
     accounts were connected, and those accounts must keep working untouched. */
  const provider = block.provider === undefined || block.provider === null ? 'microsoft' : block.provider;
  if (!MAIL_OAUTH_PROVIDERS.includes(provider)) {
    errors.push({
      path: `${at}.oauth.provider`,
      message: `must be one of ${MAIL_OAUTH_PROVIDERS.join(', ')}`,
    });
    return;
  }
  if (provider === 'google') {
    if ((block.clientId !== undefined || enabled) && !isValidGoogleClientId(block.clientId)) {
      errors.push({
        path: `${at}.oauth.clientId`,
        message: 'must be the client ID of the Google Cloud project this mailbox was signed in through',
      });
    }
    if (block.tenantId !== undefined && block.tenantId !== null && !isStr(block.tenantId)) {
      errors.push({ path: `${at}.oauth.tenantId`, message: 'must be a string' });
    }
    return;
  }
  if (block.clientId !== undefined || enabled) {
    if (!isValidClientId(block.clientId)) {
      errors.push({
        path: `${at}.oauth.clientId`,
        message: 'must be the application (client) ID from your app registration\'s Overview page, which is a GUID',
      });
    }
  }
  if (block.tenantId !== undefined && !isStr(block.tenantId)) {
    errors.push({ path: `${at}.oauth.tenantId`, message: 'must be a string' });
  } else if (!isValidTenant(block.tenantId)) {
    errors.push({
      path: `${at}.oauth.tenantId`,
      message: `must be ${TENANT_ALIASES.join(', ')}, the directory (tenant) ID from the same page, or your organisation's domain`,
    });
  }
}

function checkRef(errors, at, value, { allowNull = false, notModel = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (!allowNull) errors.push({ path: at, message: 'is required' });
    return;
  }
  if (!isValidRef(value)) {
    errors.push({ path: at, message: 'must be a short ref like "mail.m_9f3a1c" (letters, digits, . _ -)' });
  } else if (notModel && isModelKeyRef(value)) {
    // The `model.` namespace holds AI keys, each read only for the address it
    // was saved for. Anything else naming one would send it to its own host.
    errors.push({ path: at, message: 'must not name an AI key (refs starting "model.")' });
  }
}

/**
 * `oauth.clients` — the operator's own sign-in registrations, overriding the
 * ones Zelos ships (core/sources/oauth.mjs `DEFAULT_OAUTH_CLIENTS`).
 *
 * Only this one key under `oauth` is checked; the rest of the block belongs to
 * the calendar module and is left alone, as the KNOWN_TOP_LEVEL note says. A
 * Google client's SECRET is never here — `stripSecrets` removes a
 * `clientSecret` at any depth on save — only the ref it is filed under, and
 * only when the operator wants a name other than the default.
 */
function checkOAuthClients(errors, block) {
  if (block === undefined || block === null) return;
  if (!isPlainObject(block)) {
    errors.push({ path: 'oauth', message: 'must be an object' });
    return;
  }
  const clients = block.clients;
  if (clients === undefined || clients === null) return;
  if (!isPlainObject(clients)) {
    errors.push({ path: 'oauth.clients', message: 'must be an object' });
    return;
  }
  for (const [provider, entry] of Object.entries(clients)) {
    const at = `oauth.clients.${provider}`;
    if (!MAIL_OAUTH_PROVIDERS.includes(provider)) {
      errors.push({ path: at, message: `must be one of ${MAIL_OAUTH_PROVIDERS.join(', ')}` });
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push({ path: at, message: 'must be an object' });
      continue;
    }
    if (entry.clientId !== undefined && !isStr(entry.clientId)) {
      errors.push({ path: `${at}.clientId`, message: 'must be a string' });
    } else if (provider === 'microsoft' && isStr(entry.clientId) && entry.clientId.trim() && !isValidClientId(entry.clientId)) {
      errors.push({ path: `${at}.clientId`, message: 'must be the application (client) ID from your app registration\'s Overview page, which is a GUID' });
    } else if (provider === 'google' && isStr(entry.clientId) && entry.clientId.trim() && !isValidGoogleClientId(entry.clientId)) {
      errors.push({ path: `${at}.clientId`, message: 'must be the client ID from your Google Cloud project\'s credentials page' });
    }
    if (provider === 'microsoft') {
      if (entry.tenantId !== undefined && !isStr(entry.tenantId)) {
        errors.push({ path: `${at}.tenantId`, message: 'must be a string' });
      } else if (!isValidTenant(entry.tenantId)) {
        errors.push({
          path: `${at}.tenantId`,
          message: `must be ${TENANT_ALIASES.join(', ')}, the directory (tenant) ID from the same page, or your organisation's domain`,
        });
      }
    }
    if (provider === 'google') {
      checkRef(errors, `${at}.clientSecretRef`, entry.clientSecretRef, { allowNull: true, notModel: true });
    }
  }
}

/**
 * Every key a config.json may carry at the top level. DEFAULTS holds the ones
 * this file owns; `ai` (core/ai-access.mjs, core/mcp.mjs) and `oauth`
 * (core/sources/oauth.mjs) are written and read by their own modules, which is
 * why neither has a block in `validateConfig` — they are not unknown, they are
 * somebody else's.
 *
 * A key outside this set is REPORTED, never dropped and never refused. Doctor
 * tells people to edit config.json by hand, and a `"sweeps"` typed beside the
 * real `sweep` (or a `"privacy "` with a trailing space) merged, saved, echoed
 * back and did nothing, while doctor called the file valid — the setting the
 * user thought they had changed was inert and nothing said so. Refusing it
 * would be worse than keeping it: a file written by a newer build carries keys
 * this one has never heard of, and a TypeError on those would block every
 * later save — including the one that removes the key.
 */
const KNOWN_TOP_LEVEL = new Set([...Object.keys(DEFAULTS), 'ai', 'oauth']);

/** -> {ok, errors:[{path, message}]} */
export function validateConfig(cfg) {
  const errors = [];
  if (!isPlainObject(cfg)) return { ok: false, errors: [{ path: '', message: 'config must be an object' }] };

  const leaked = [];
  stripSecrets(cfg, '', leaked);
  for (const p of leaked) errors.push({ path: p, message: 'credentials must live in the secret store, not in config.json' });

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL.has(key)) errors.push({ path: key, message: 'is not a setting Zelos knows — check the spelling' });
  }

  if (!isInt(cfg.version, 1, 1000)) errors.push({ path: 'version', message: 'must be a positive integer' });

  const id = cfg.identity;
  if (!isPlainObject(id)) errors.push({ path: 'identity', message: 'must be an object' });
  else {
    if (!isStr(id.name)) errors.push({ path: 'identity.name', message: 'must be a string' });
    if (!isStr(id.email)) errors.push({ path: 'identity.email', message: 'must be a string' });
    else if (id.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id.email)) errors.push({ path: 'identity.email', message: 'is not an email address' });
    if (!isStr(id.timezone)) errors.push({ path: 'identity.timezone', message: 'must be a string' });
    else if (id.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: id.timezone }); }
      catch { errors.push({ path: 'identity.timezone', message: `unknown IANA timezone: ${id.timezone}` }); }
    }
  }

  const m = cfg.model;
  if (!isPlainObject(m)) errors.push({ path: 'model', message: 'must be an object' });
  else {
    if (!PROTOCOLS.includes(m.protocol)) errors.push({ path: 'model.protocol', message: `must be one of ${PROTOCOLS.join(', ')}` });
    if (!isStr(m.label)) errors.push({ path: 'model.label', message: 'must be a string' });
    checkUrl(errors, 'model.baseUrl', m.baseUrl, { schemes: ['http:', 'https:'], required: true });
    if (!isStr(m.model)) errors.push({ path: 'model.model', message: 'must be a string' });
    checkRef(errors, 'model.keyRef', m.keyRef, { allowNull: true });
    if (!isInt(m.maxTokens, 1, 1_000_000)) errors.push({ path: 'model.maxTokens', message: 'must be an integer between 1 and 1000000' });
    if (typeof m.temperature !== 'number' || !(m.temperature >= 0 && m.temperature <= 2)) errors.push({ path: 'model.temperature', message: 'must be a number between 0 and 2' });
  }

  if (!Array.isArray(cfg.mail)) errors.push({ path: 'mail', message: 'must be an array' });
  else {
    const seen = new Set();
    cfg.mail.forEach((a, i) => {
      const at = `mail[${i}]`;
      if (!isPlainObject(a)) { errors.push({ path: at, message: 'must be an object' }); return; }
      if (!isStr(a.id) || !a.id) errors.push({ path: `${at}.id`, message: 'is required' });
      else if (seen.has(a.id)) errors.push({ path: `${at}.id`, message: `duplicate account id ${a.id}` });
      else seen.add(a.id);
      if (!isBool(a.enabled)) errors.push({ path: `${at}.enabled`, message: 'must be a boolean' });
      if (!isStr(a.label)) errors.push({ path: `${at}.label`, message: 'must be a string' });
      if (a.enabled && (!isStr(a.host) || !a.host.trim())) errors.push({ path: `${at}.host`, message: 'is required for an enabled account' });
      if (a.enabled && (!isStr(a.user) || !a.user.trim())) errors.push({ path: `${at}.user`, message: 'is required for an enabled account' });
      if (!isInt(a.port, 1, 65535)) errors.push({ path: `${at}.port`, message: 'must be a port number' });
      if (!isBool(a.secure)) errors.push({ path: `${at}.secure`, message: 'must be a boolean' });
      if (a.requireTls !== null && !isBool(a.requireTls)) errors.push({ path: `${at}.requireTls`, message: 'must be true, false, or null to decide from the host' });
      /* Absent reads as `password`, because that is what every account written
         before this key existed is doing. Anything else is refused rather than
         coerced: an `auth: "oauth2"` or `auth: "XOAUTH2"` that quietly fell back
         to a password is the exact defect this pass exists to close — a config
         that says one thing while the sweep does another. */
      const method = a.auth === undefined ? 'password' : a.auth;
      if (!MAIL_AUTH_METHODS.includes(method)) {
        errors.push({ path: `${at}.auth`, message: `must be one of ${MAIL_AUTH_METHODS.join(', ')}` });
      }
      checkMailOAuth(errors, at, a, { method, enabled: a.enabled === true });
      checkRef(errors, `${at}.keyRef`, a.keyRef, { allowNull: !a.enabled, notModel: true });
      if (!Array.isArray(a.mailboxes) || a.mailboxes.length === 0 || !a.mailboxes.every(isStr)) errors.push({ path: `${at}.mailboxes`, message: 'must be a non-empty array of mailbox names' });
      if (!isStr(a.sentMailbox)) errors.push({ path: `${at}.sentMailbox`, message: 'must be a string' });
      if (!isInt(a.lookbackDays, 1, 365)) errors.push({ path: `${at}.lookbackDays`, message: 'must be an integer between 1 and 365' });
      if (!isInt(a.maxMessages, 1, 5000)) errors.push({ path: `${at}.maxMessages`, message: 'must be an integer between 1 and 5000' });
    });
  }

  checkOAuthClients(errors, cfg.oauth);

  if (!Array.isArray(cfg.calendars)) errors.push({ path: 'calendars', message: 'must be an array' });
  else {
    const seen = new Set();
    cfg.calendars.forEach((c, i) => {
      const at = `calendars[${i}]`;
      if (!isPlainObject(c)) { errors.push({ path: at, message: 'must be an object' }); return; }
      if (!isStr(c.id) || !c.id) errors.push({ path: `${at}.id`, message: 'is required' });
      else if (seen.has(c.id)) errors.push({ path: `${at}.id`, message: `duplicate calendar id ${c.id}` });
      else seen.add(c.id);
      if (!isBool(c.enabled)) errors.push({ path: `${at}.enabled`, message: 'must be a boolean' });
      if (!isStr(c.label)) errors.push({ path: `${at}.label`, message: 'must be a string' });
      if (!CALENDAR_KINDS.includes(c.kind)) errors.push({ path: `${at}.kind`, message: `must be one of ${CALENDAR_KINDS.join(', ')}` });
      else if (c.kind === 'file') {
        if (c.enabled && (!isStr(c.url) || !c.url.trim())) errors.push({ path: `${at}.url`, message: 'is required for an enabled calendar' });
      } else {
        // webcal: is how Apple and friends publish an https .ics; the fetcher normalises it.
        checkUrl(errors, `${at}.url`, c.url, { schemes: ['http:', 'https:', 'webcal:'], required: !!c.enabled });
      }
      if (!isStr(c.user)) errors.push({ path: `${at}.user`, message: 'must be a string' });
      checkRef(errors, `${at}.keyRef`, c.keyRef, { allowNull: true, notModel: true });
    });
  }

  /**
   * `sources` — the envelope, and deliberately not the payload.
   *
   * Absent rather than empty is valid, because a config.json written before this
   * key existed has none and `zelos doctor` must not call it broken. What is
   * checked is what every reader of the array needs to be true: an id it can
   * key `kv` rows and a secret ref off, a boolean it can filter on, a type
   * string, and a settings object. `type` is NOT checked against the registry —
   * see SOURCE_DEFAULTS for why config cannot import it — and the per-connector
   * fields are not checked here at all. The registry validates the payload; a
   * source naming a connector that does not exist is reported by doctor, not by
   * refusing to load the file.
   */
  if (cfg.sources !== undefined) {
    if (!Array.isArray(cfg.sources)) errors.push({ path: 'sources', message: 'must be an array' });
    else {
      const seen = new Set();
      cfg.sources.forEach((src, i) => {
        const at = `sources[${i}]`;
        if (!isPlainObject(src)) { errors.push({ path: at, message: 'must be an object' }); return; }
        if (!isStr(src.id) || !src.id) errors.push({ path: `${at}.id`, message: 'is required' });
        else if (seen.has(src.id)) errors.push({ path: `${at}.id`, message: `duplicate source id ${src.id}` });
        else seen.add(src.id);
        if (!isBool(src.enabled)) errors.push({ path: `${at}.enabled`, message: 'must be a boolean' });
        if (!isStr(src.label)) errors.push({ path: `${at}.label`, message: 'must be a string' });
        if (!isStr(src.type) || !src.type.trim()) errors.push({ path: `${at}.type`, message: 'is required' });
        checkRef(errors, `${at}.keyRef`, src.keyRef, { allowNull: true, notModel: true });
        if (!isPlainObject(src.settings)) errors.push({ path: `${at}.settings`, message: 'must be an object' });
      });
    }
  }

  const s = cfg.sweep;
  if (!isPlainObject(s)) errors.push({ path: 'sweep', message: 'must be an object' });
  else {
    const [everyMin, everyMax] = SWEEP_INTERVAL_RANGE;
    if (!isInt(s.intervalMinutes, everyMin, everyMax)) errors.push({ path: 'sweep.intervalMinutes', message: `must be an integer between ${everyMin} and ${everyMax}` });
    if (!Array.isArray(s.activeHours) || s.activeHours.length !== 2 || !s.activeHours.every((h) => isInt(h, 0, 23))) {
      errors.push({ path: 'sweep.activeHours', message: 'must be [startHour, endHour] with each 0-23' });
    } else if (s.activeHours[0] >= s.activeHours[1]) {
      errors.push({ path: 'sweep.activeHours', message: 'start hour must be before end hour' });
    }
    if (!isBool(s.auto)) errors.push({ path: 'sweep.auto', message: 'must be a boolean' });
  }

  if (!isPlainObject(cfg.ui)) errors.push({ path: 'ui', message: 'must be an object' });
  else if (!ACCENT_RE.test(String(cfg.ui.accent ?? ''))) errors.push({ path: 'ui.accent', message: 'must be a six-digit hex colour like #5b8cff' });

  const p = cfg.privacy;
  if (!isPlainObject(p)) errors.push({ path: 'privacy', message: 'must be an object' });
  else {
    const [itemsMin, itemsMax] = PRIVACY_RANGES.maxItemsPerSweep;
    const [charsMin, charsMax] = PRIVACY_RANGES.bodyChars;
    if (!isInt(p.maxItemsPerSweep, itemsMin, itemsMax)) errors.push({ path: 'privacy.maxItemsPerSweep', message: `must be an integer between ${itemsMin} and ${itemsMax}` });
    if (!isBool(p.sendBodies)) errors.push({ path: 'privacy.sendBodies', message: 'must be a boolean' });
    if (!isInt(p.bodyChars, charsMin, charsMax)) errors.push({ path: 'privacy.bodyChars', message: `must be an integer between ${charsMin} and ${charsMax}` });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The privacy settings as the engine must honour them, failing CLOSED.
 *
 * A PUT is saved first and reported second, so a value validateConfig refuses
 * can still be on disk: `bodyChars: null`, `sendBodies: 0`, `"false"`. The
 * readers used to fall back to the default for anything that was not a
 * number, and to send bodies for anything that was not exactly `false`, so a
 * blank cap meant 4,000 characters and a mistyped switch meant "on" (QA,
 * 2026-10-10, TT-3424). Now an ABSENT value takes the default, as a config
 * written before the setting existed must, and a value that is PRESENT but
 * not usable takes the most private reading the setting allows: bodies off,
 * no body characters, one item. A number past the top of its range is held
 * to that top. The "Still incomplete" banner names the bad value meanwhile.
 */
export function privacyLimits(privacy) {
  const fallback = DEFAULTS.privacy;
  if (privacy === undefined) return { ...fallback };
  // A section that is there but is not an object (null, a string) is a value
  // present but unusable, the same as each setting inside it.
  if (!isPlainObject(privacy)) return { ...PRIVACY_CLOSED };
  const given = (key) => Object.hasOwn(privacy, key) && privacy[key] !== undefined;
  const within = (key) => {
    const [, top] = PRIVACY_RANGES[key];
    const value = privacy[key];
    if (!given(key)) return fallback[key];
    if (!Number.isFinite(value)) return PRIVACY_CLOSED[key];
    return Math.min(top, Math.max(PRIVACY_CLOSED[key], Math.floor(value)));
  };
  const bodyChars = within('bodyChars');
  // No body characters means no body content of any kind, event descriptions
  // included: a zeroed cap is read as the switch off, not as "a body too
  // short to send, but the notes still go".
  const sendBodies = bodyChars > 0 && (given('sendBodies') ? privacy.sendBodies === true : fallback.sendBodies);
  return { sendBodies, bodyChars, maxItemsPerSweep: within('maxItemsPerSweep') };
}
