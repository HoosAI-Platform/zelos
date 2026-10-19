/**
 * core/connectors/index.mjs — the registry the sweep, the doctor and the
 * Settings picker read instead of each keeping their own list.
 *
 * Nothing under core/sources/ moved. That is 4,880 lines of protocol code
 * behind 4,579 lines of tests, and it stays the protocol library; this
 * directory is the thin thing the run loop talks to. A connector is a
 * description of a source plus one function, and the whole of the interface is
 * in `assertShape` below — which runs at module load, so a malformed connector
 * fails the import in CI rather than at 07:00 on somebody's laptop.
 *
 * TWO RULES THAT LOOK LIKE STYLE AND ARE NOT.
 *
 * A STATIC IMPORT LIST, NEVER A DIRECTORY SCAN. test/repo.test.mjs reads every
 * import specifier in core/, ui/ and test/ as TEXT and asserts each resolves to
 * a node: builtin or a relative path — that scanner is the guard behind the
 * zero-dependency claim, and a computed `import()` is invisible to it.
 * package.json also excludes core/sources/oauth.mjs from the tarball by name,
 * and desktop/dist/.../Resources/core/ is a copy: a scan would behave
 * differently depending on what got copied.
 *
 * core/config.mjs MUST NEVER IMPORT THIS FILE. core/sources/caldav.mjs:34
 * imports `paths` and `writeFileAtomic` from ../config.mjs; `paths()` is only
 * called lazily, so ESM survives it today, but a registry that imports caldav,
 * imported in turn by config, is one eager call away from a TDZ crash at launch
 * in the module that resolves the home directory. The cost of honouring it is
 * that CALENDAR_KINDS is stated in both files; the cross-check test in
 * test/connectors.test.mjs is what keeps them equal.
 */

import { SECRET_KEYS } from '../config.mjs';

import imap from './imap.mjs';
import ics from './ics.mjs';
import caldav from './caldav.mjs';
import file from './file.mjs';
import rss from './rss.mjs';
import github from './github.mjs';
import slack from './slack.mjs';
import fireflies from './fireflies.mjs';
import linear from './linear.mjs';
import todoist from './todoist.mjs';
import folder from './folder.mjs';
import whatsapp from './whatsapp.mjs';

/** Where a source's config entry lives on disk. */
export const CONFIG_KEYS = Object.freeze(['mail', 'calendars', 'sources']);

/** The entire vocabulary of what a connector may produce. See §8.4 of the brief. */
export const SINKS = Object.freeze(['messages', 'events']);

/**
 * The closed set of field types.
 *
 * Six, because core/config.mjs already implements a checker for each (`isStr`,
 * `isBool`, `isInt`, `checkUrl`) and ui/views/settings.js already has a control
 * for each. There is deliberately no `password`: a password typed into a field
 * would travel in a config patch, and there is exactly one credential per
 * source, declared by `credential` and stored behind `keyRef`.
 */
export const FIELD_TYPES = Object.freeze(['text', 'url', 'path', 'int', 'bool', 'choice']);

/**
 * Every key a manifest may carry.
 *
 * This is where non-negotiable #2 — Zelos renders, a human clicks — stops being
 * a convention and becomes a property of the shape. There is no `send`, no
 * `reply`, no `archive`, no `complete`, and no way to add one without editing
 * this line, which is a line a reviewer can find. `read` is here only because
 * the four connectors that predate this interface carry the sweep's existing
 * `deps` seams; connector number nine implements `collect` and nothing else.
 */
const ALLOWED_KEYS = new Set([
  'type', 'family', 'label', 'option', 'configKey', 'sink',
  'credential', 'origins', 'fields', 'limits', 'graphql',
  'collect', 'check', 'read', 'onConfigChanged',
  'taskPrefix',
]);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Refuse a malformed connector at import time.
 *
 * Not decoration. Every clause below is a defect somebody would otherwise find
 * in production, and the last one is the one nobody would think of.
 */
export function assertShape(c, seen = new Set()) {
  const at = isPlainObject(c) && nonEmpty(c.type) ? c.type : '(unnamed)';
  const bad = (why) => { throw new TypeError(`connector ${at}: ${why}`); };

  if (!isPlainObject(c)) bad('must be an object');
  for (const key of Object.keys(c)) {
    if (!ALLOWED_KEYS.has(key)) {
      bad(`declares "${key}", which is not part of the connector interface. `
        + 'Zelos is read-only: there is no slot for a verb that changes anything at a source.');
    }
  }

  if (!nonEmpty(c.type) || !/^[a-z][a-z0-9_-]*$/.test(c.type)) bad('needs a lowercase `type` — it is the registry key and the on-disk kind');
  if (seen.has(c.type)) bad('is registered twice');
  seen.add(c.type);

  if (!nonEmpty(c.family)) bad('needs a `family` — the sources[] kind, the keyRef prefix and the progress phase are one string on purpose');
  if (!nonEmpty(c.label)) bad('needs a `label`');
  if (!nonEmpty(c.option)) bad('needs an `option` — the sentence a person picks in Settings');
  if (!CONFIG_KEYS.includes(c.configKey)) bad(`configKey must be one of ${CONFIG_KEYS.join(', ')}`);
  if (!SINKS.includes(c.sink)) bad(`sink must be one of ${SINKS.join(', ')}`);
  if (typeof c.collect !== 'function') bad('needs a collect(ctx) function');
  if (c.check !== undefined && typeof c.check !== 'function') bad('check must be a function');
  if (c.read !== undefined && typeof c.read !== 'function') bad('read must be a function');
  if (c.onConfigChanged !== undefined && typeof c.onConfigChanged !== 'function') bad('onConfigChanged must be a function');
  if (c.graphql !== undefined && typeof c.graphql !== 'boolean') bad('graphql must be a boolean');
  if (c.taskPrefix !== undefined && (c.sink !== 'messages' || !nonEmpty(c.taskPrefix) || c.taskPrefix.length > 100)) {
    bad('taskPrefix must be a bounded message-id namespace on a messages connector');
  }

  if (!Array.isArray(c.origins)) {
    bad('needs an `origins` array. `ctx.http` refuses every host that is not on it, '
      + 'which is what makes "a URL that arrived inside a payload is not fetchable" true rather than intended.');
  }
  for (const o of c.origins) {
    if (!nonEmpty(o)) bad('origins must be absolute http(s) addresses');
    let u;
    try { u = new URL(o); } catch { bad(`origin ${o} is not a URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`origin ${o} must be http or https`);
    if (u.origin !== o.replace(/\/$/, '')) bad(`origin ${o} must be a bare origin, with no path`);
  }

  if (c.credential !== null && c.credential !== undefined) {
    const cr = c.credential;
    if (!isPlainObject(cr)) bad('credential must be an object or null');
    if (!nonEmpty(cr.label)) bad('credential needs a label — it is what the user is asked to paste');
    if (cr.required !== undefined && typeof cr.required !== 'boolean') bad('credential.required must be a boolean');
    if (cr.urlFor !== undefined && typeof cr.urlFor !== 'function') bad('credential.urlFor must be a function');
    if (cr.send !== undefined) {
      const s = cr.send;
      if (!isPlainObject(s)) bad('credential.send must be an object');
      if (s.as !== 'header' && s.as !== 'basic') {
        bad('credential.send.as must be "header" or "basic". There is no "query": a token in a query string '
          + "lands in the vendor's access log, in every proxy's, and in ours — core/log.mjs redacts a header by "
          + 'name and a Bearer by shape, and can do neither for ?token=… inside a URL.');
      }
    }
  }

  const names = new Set();
  for (const f of arr(c.fields)) {
    if (!isPlainObject(f)) bad('every field must be an object');
    if (!nonEmpty(f.name) || !/^[a-z][A-Za-z0-9_]*$/.test(f.name)) bad(`field name ${JSON.stringify(f.name)} must be a lowerCamel identifier`);
    if (names.has(f.name)) bad(`field ${f.name} is declared twice`);
    names.add(f.name);
    /* The clause nobody would think of. `stripSecrets` (core/config.mjs:190)
       deletes these key names ANYWHERE AT ANY DEPTH on every save and logs
       "config: refused to store credential fields". A connector field called
       `key` — holding an innocuous project key — would vanish on save with a
       warning that reads like a false positive. That behaviour is correct; this
       is the line that stops it being confusing more than once. */
    if (SECRET_KEYS.has(f.name.toLowerCase())) {
      bad(`field "${f.name}" is a name core/config.mjs strips from every save at any depth, `
        + 'so it could never be stored. Rename it, and put real credentials behind `credential`.');
    }
    if (!FIELD_TYPES.includes(f.type)) bad(`field ${f.name} has type ${JSON.stringify(f.type)}; must be one of ${FIELD_TYPES.join(', ')}`);
    if (!nonEmpty(f.label)) bad(`field ${f.name} needs a label`);
    if (f.type === 'choice' && (!Array.isArray(f.choices) || !f.choices.length)) bad(`field ${f.name} is a choice with no choices`);
  }

  const lim = c.limits;
  if (!isPlainObject(lim)) bad('needs a `limits` object');
  for (const k of ['minIntervalMs', 'minGapMs']) {
    if (!Number.isFinite(lim[k]) || lim[k] < 0) bad(`limits.${k} must be a number of milliseconds, zero or more`);
  }
  if (lim.budget !== null && lim.budget !== undefined) {
    if (!isPlainObject(lim.budget)) bad('limits.budget must be {calls, perMs} or null');
    if (!Number.isFinite(lim.budget.calls) || lim.budget.calls <= 0) bad('limits.budget.calls must be a positive number');
    if (!Number.isFinite(lim.budget.perMs) || lim.budget.perMs <= 0) bad('limits.budget.perMs must be a positive number');
  }
  if (lim.maxRows !== null && lim.maxRows !== undefined && (!Number.isInteger(lim.maxRows) || lim.maxRows <= 0)) {
    bad('limits.maxRows must be a positive integer or null');
  }

  return c;
}

const seenTypes = new Set();
const LIST = [imap, ics, caldav, file, rss, github, slack, fireflies, linear, todoist, folder, whatsapp]
  .map((c) => deepFreeze(assertShape(c, seenTypes)));
const BY_TYPE = new Map(LIST.map((c) => [c.type, c]));

/** The connector for a `kind`/`type` string, or null. Never throws. */
export const get = (type) => BY_TYPE.get(String(type ?? '')) ?? null;

/**
 * Add a connector after module load, and hand back the way to take it out again.
 *
 * NOTHING IN PRODUCTION CALLS THIS, and test/connectors.test.mjs asserts that no
 * file outside this one does. The static import list above stays the only way a
 * connector ships, for the reason at the top of this file.
 *
 * It exists because the alternative proof that the seam is real is a grep, and a
 * grep cannot tell a registry from decoration — three surfaces (the Settings
 * picker, config validation, `zelos doctor`) each read a list of source kinds,
 * and the only way to show they read THIS list is to put something in it that no
 * other file names and watch all three find it. That test is the reason the
 * hardcoded lists cannot come back without somebody noticing.
 *
 * The type is released on removal rather than left in `seenTypes`, so the same
 * throwaway can be registered by more than one test: keeping it would make the
 * second `register` throw "is registered twice" about a connector that is not
 * there any more.
 */
export function register(connector) {
  const frozen = deepFreeze(assertShape(connector, seenTypes));
  LIST.push(frozen);
  BY_TYPE.set(frozen.type, frozen);
  return function unregister() {
    const at = LIST.indexOf(frozen);
    if (at >= 0) LIST.splice(at, 1);
    BY_TYPE.delete(frozen.type);
    seenTypes.delete(frozen.type);
  };
}

/** Every registered connector, in declaration order. */
export const all = () => [...LIST];

/** The types stored under one config key, in declaration order. */
export const typesFor = (configKey) => LIST.filter((c) => c.configKey === configKey).map((c) => c.type);

/**
 * The JSON-safe half of every manifest.
 *
 * For the UI, which reaches core/ only over HTTP — test/repo.test.mjs asserts
 * ui/ is standalone and offline — so this must survive JSON.stringify. No
 * functions, and nothing a connector could use to smuggle markup into a page:
 * Settings renders from `fields[]` and ui/ never assigns untrusted text to
 * innerHTML.
 */
export const describe = () => LIST.map((c) => ({
  type: c.type,
  family: c.family,
  label: c.label,
  option: c.option,
  configKey: c.configKey,
  sink: c.sink,
  graphql: c.graphql === true,
  credential: c.credential
    ? {
      label: c.credential.label,
      help: c.credential.help ?? '',
      url: c.credential.url ?? '',
      required: c.credential.required === true,
    }
    : null,
  origins: [...c.origins],
  fields: c.fields.map((f) => ({ ...f })),
  limits: {
    minIntervalMs: c.limits.minIntervalMs,
    minGapMs: c.limits.minGapMs,
    budget: c.limits.budget ? { ...c.limits.budget } : null,
    maxRows: c.limits.maxRows ?? null,
  },
}));

/**
 * Every host `ctx.http` will contact for this source: what the connector
 * declared, plus what the USER configured.
 *
 * The second half is why a feed connector can declare no origins at all and
 * still work — `source.url` and every `type: 'url'` field the user filled in are
 * addresses they chose. Nothing a document said is in here, which is the whole
 * property: a redirect target, a feed's <link>, an issue body naming a host —
 * none of them widen the list.
 */
export function originsFor(connector, source) {
  const out = [...arr(connector?.origins)];
  if (nonEmpty(source?.url)) out.push(source.url);
  const settings = isPlainObject(source?.settings) ? source.settings : {};
  for (const f of arr(connector?.fields)) {
    if (f.type !== 'url') continue;
    const v = settings[f.name];
    if (nonEmpty(v)) out.push(v);
  }
  return out;
}

/** The two `kv` keys one source owns. See core/sweep.mjs for what is in them. */
export const sourceCursorKey = (id) => `source.${id}.cursor`;
export const sourceStateKey = (id) => `source.${id}.state`;

/**
 * Every enabled source, from all three places config keeps them.
 *
 * `mail` and `calendars` are NOT migrated into `sources`, and that is the point
 * of this function rather than a shortcoming of it. Migrating them would
 * rewrite config.json on every user's disk, rewrite MAIL_ACCOUNT_DEFAULTS and
 * CALENDAR_DEFAULTS, rewrite normalizeAccounts, rewrite both validator arms,
 * and rewrite fixtures in six test files — to buy nothing a fifteen-line
 * adapter does not. `mail[i].requireTls` alone is three-valued with twenty
 * lines of justification at core/config.mjs:43-59, and a generic settings blob
 * loses both it and the per-field sentences `zelos doctor` prints.
 *
 * An entry naming no connector is dropped HERE and reported by doctor. It does
 * not throw: core/config.mjs:236-238 is explicit that a hand-edited typo must
 * not brick the app that exists to report the typo.
 */
export function enabledSources(config) {
  const out = [];
  const push = (type, source) => {
    const connector = get(type);
    /* `source` is tested for its own existence, not only for `enabled`. The
       first cut wrote `source?.enabled !== false`, which is true for `null` —
       so a null entry produced `{connector, source: null}`, the host read
       `source.label` off it, and the rejection escaped both `Promise.all` and
       `runSweep`. `finish()` then never ran and the `runs` row `startRun`
       opened was left unfinished, which is worse than the sweep failing: the
       board shows a run that is still going and never will be. Production
       reaches this only through an injected config, since `normalizeAccounts`
       filters non-objects, but the old `isEnabled` opened with `!!x` and this
       is a refactor. */
    if (connector && source && source.enabled !== false) out.push({ connector, source });
  };
  for (const a of arr(config?.mail)) push('imap', a);
  /* An unrecognised calendar `kind` falls back to the .ics reader rather than
     disappearing, because that is what the code this replaced did: the old
     `defaultFetchEvents` tested `=== 'file'`, then `=== 'caldav'`, and let
     everything else reach `fetchIcsText`. A typo like `webcal` therefore
     produced a real `sources[]` row — events if the URL happened to serve a
     calendar, a named error in the Now banner if it did not. Dispatching
     strictly instead made the row vanish silently, which is the one outcome a
     user cannot debug: a calendar they can see in Settings, contributing
     nothing, with nothing anywhere saying why.

     THAT REASON HAS NOW EXPIRED, AND THIS LINE HAS NOT BEEN CHANGED WITH IT.
     `unknownSources()` finally has a production reader: core/doctor.mjs runs it
     on every `zelos doctor` and names each entry, its id and the kind nobody
     claims. So "the row vanishes and nothing says why" is no longer what a
     strict dispatch costs — the row would vanish and `zelos doctor` would say
     exactly why — and this fallback can become a drop, which is what the
     `sources[]` line below already does.

     It is deliberately left alone in this pass. test/connectors.test.mjs pins
     the fallback and explains the ordering in the same breath, so changing the
     behaviour and the test that documents it in one diff is the change nobody
     can review. The next pass is: drop here, update that test, and check
     ui/views/now.js still has something to show for a calendar that has stopped
     being read. */
  for (const c of arr(config?.calendars)) push(get(c?.kind) ? c?.kind : 'ics', c);
  for (const s of arr(config?.sources)) push(s?.type, s);
  return out;
}

/**
 * The entries config holds that name no connector at all.
 *
 * `enabledSources` drops them silently because a sweep must still run; this is
 * what `zelos doctor` reads to say why nothing arrived from one of them.
 */
export function unknownSources(config) {
  const out = [];
  for (const c of arr(config?.calendars)) {
    if (!get(c?.kind)) out.push({ at: 'calendars', id: c?.id ?? '', type: String(c?.kind ?? ''), source: c });
  }
  for (const s of arr(config?.sources)) {
    if (!get(s?.type)) out.push({ at: 'sources', id: s?.id ?? '', type: String(s?.type ?? ''), source: s });
  }
  return out;
}
