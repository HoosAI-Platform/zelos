/**
 * core/ai-access.mjs — who is allowed to ask Zelos anything, and what they got.
 *
 * SPEC-v2 §1 turns Zelos into a knowledge source another AI can connect to over
 * MCP. That is the one feature in this app that hands a user's mail to a program
 * they did not write, so the governing rule is written down here rather than
 * left to whoever wires the route:
 *
 *   **Off by default, scoped by the user, forever.**
 *
 * Three things make that rule real. This module owns the first two outright and
 * is the door onto the third:
 *
 *  1. **Tokens.** Access needs a bearer token the user minted for one named
 *     client. The value is shown ONCE, at creation, and then it lives in the
 *     secret store like every other credential — `config.json` holds only
 *     `{id, label, ref, createdAt, lastUsedAt}`. There is no read path, here or
 *     over HTTP. Losing it means minting a new one, which is the correct trade:
 *     a token that can be read back is a token that can be stolen twice.
 *  2. **Scopes.** A closed set, each individually toggled, stored in
 *     `config.ai.scopes`. `mail.bodies` is the one that matters and is treated
 *     as such: it is off unless explicitly turned on, and it is never turned on
 *     as a side effect of anything. `setAiSettings` is the only writer, and it
 *     refuses a key that is not in the set.
 *  3. **The log.** Every call is recorded locally with the tool, the scope and
 *     how many rows came back, so a person can answer "what did my AI read?"
 *     The rows are written by core/mcp.mjs — one table, whichever transport the
 *     call arrived on — and re-exported here so the Settings routes have one
 *     import rather than two.
 *
 * The scope set, the tools, the JSON-RPC protocol and the audit log all live in
 * `core/mcp.mjs` and are re-exported here rather than restated: two definitions
 * of "what a scope is" would drift, and the one that drifted would be the one a
 * security decision was made against. This file knows nothing about JSON-RPC —
 * it is the gate, not the road.
 */

import crypto from 'node:crypto';

import { loadConfig, saveConfig, newId, isValidRef, paths } from './config.mjs';
import { setSecret, getSecret, deleteSecret, secretVersion } from './secrets.mjs';
import { SCOPES, aiConfig as mcpAiConfig } from './mcp.mjs';
import { cap } from './safety.mjs';
import { nowISO } from './time.mjs';
import { log } from './log.mjs';

/**
 * One definition of the scope set, the descriptions, the defaults and the audit
 * log — core/mcp.mjs's. Re-exported so a caller that has this module does not
 * need both.
 */
export { SCOPES, SCOPE_INFO, AI_DEFAULTS } from './mcp.mjs';
export { recordAccess, listAccessLog } from './mcp.mjs';

const MAX_TOKENS = 20;
const MAX_LABEL_CHARS = 60;

/**
 * The secret store, as a seam.
 *
 * The race every writer below has to survive is defined by what happens
 * *during* the store's latency, and that latency is real: on macOS a write is a
 * spawn of /usr/bin/security, tens to hundreds of milliseconds with a whole
 * event loop running underneath it. On the encrypted-file backend the same call
 * costs nothing, so a test that only ever sees that backend cannot get inside
 * the window at all. Passing the store in lets one hold a mint open across a
 * revocation and watch which list reaches the disk.
 */
const STORE = { setSecret, deleteSecret, getSecret, secretVersion };

/* ------------------------------------------------------------------ *
 * What a token check remembers
 * ------------------------------------------------------------------ */

/**
 * Reading a stored token is a spawn on every OS store, and on Windows it is a
 * PowerShell start — about 180 ms — so checking one per MCP request held a
 * client to roughly five calls a second, one process each (TT-3497). What is
 * remembered instead is the SHA-256 of the stored value, never the value: a
 * digest is enough to compare a presented token against, and it is no use to
 * anything that reads this process's memory and wants to present one.
 *
 * A remembered digest is believed only while nothing says it is stale. Every
 * use re-reads the token record from disk and the master switch with it, so a
 * revocation or a switch-off in another window bites on the next call exactly
 * as it did. The store must also report the same version (secretVersion in
 * core/secrets.mjs): the same write generation in this process, and on the
 * file-backed stores the same file stamp. A change it cannot see — a keychain
 * edited by another program — is bounded by VERIFIED_TTL_MS.
 */
const VERIFIED_TTL_MS = 60_000;
const verified = new Map();
// Bumped by every invalidation. A store read that started before one does not
// get to remember its answer afterwards.
let verifiedEpoch = 0;

function verifiedKey(record) {
  return `${paths().home}\0${record.id}\0${record.ref}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function forgetVerified(id = null) {
  verifiedEpoch += 1;
  if (id === null) { verified.clear(); return; }
  const home = paths().home;
  for (const [key, entry] of verified) {
    if (entry.home === home && entry.id === id) verified.delete(key);
  }
}

/** Testing seam: forget every remembered token check. */
export function resetVerifiedTokens() {
  forgetVerified();
}

/* ------------------------------------------------------------------ *
 * Reading the config block
 * ------------------------------------------------------------------ */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `config.ai`, normalised. `mcpAiConfig` does the scope and switch work — same
 * function the tool layer uses, so the two can never disagree about what is on.
 * The extra pass here is on the token records, which the tool layer does not
 * care about and this file cannot proceed without: a record whose `ref` is not a
 * valid secret ref is not a token, it is a line in a file, and treating it as
 * one would mean handing an arbitrary string to the secret store.
 *
 * It does NOT cap the list at `MAX_TOKENS`. The cap belongs on the way in, in
 * `mintToken`, where refusing costs the user nothing; applying it on the way out
 * would mean the next save silently wrote back a shorter list and revoked
 * somebody's client without telling them.
 */
export function aiConfig(config = null) {
  const normalized = mcpAiConfig(config);
  return {
    ...normalized,
    tokens: normalized.tokens
      .filter((t) => t.id && isValidRef(t.ref))
      .map((t) => ({
        id: t.id,
        label: cap(t.label, MAX_LABEL_CHARS) || t.id,
        ref: t.ref,
        createdAt: t.createdAt || '',
        lastUsedAt: t.lastUsedAt || null,
      })),
  };
}

/**
 * The `ai` block as it is ON DISK, right now.
 *
 * Every writer in this file calls this immediately before its save, for the
 * reason spelled out at length on `touchToken`: `saveConfig` replaces the whole
 * `ai.tokens` array, so a caller that took its snapshot a moment ago — before an
 * await, before an HTTP round trip, before another window's revocation — writes
 * that snapshot's list over everything that happened in between. The caller's
 * snapshot is the right source for what the caller *asked for*. It is never the
 * right source for the parts it is not changing.
 */
function liveAi() {
  return aiConfig(loadConfig());
}

/** True only when the master switch is on. Nothing else may stand in for it. */
export function aiEnabled(config) {
  return aiConfig(config).enabled === true;
}

/**
 * The scopes a call actually gets. `mail.bodies` implies `mail.metadata` —
 * reading a message body without its sender would be a strange half-grant — and
 * the implication runs in that direction only. Turning on metadata never turns
 * on bodies. The Settings panel shows this next to the stored toggles so a
 * person can see the grant without it looking like a box they ticked.
 */
export function effectiveScopes(config) {
  const scopes = { ...aiConfig(config).scopes };
  if (scopes['mail.bodies']) scopes['mail.metadata'] = true;
  return scopes;
}

/** The enabled scope ids, as a plain array, for anything that wants a list. */
export function enabledScopes(config) {
  const scopes = effectiveScopes(config);
  return SCOPES.filter((key) => scopes[key]);
}

/**
 * What the Settings panel is allowed to see about a token: a label, when it was
 * made, when it was last used. Never the value, and never the ref — a ref is a
 * handle into the secret store and nothing outside this process needs one.
 */
export function listTokens(config) {
  return aiConfig(config).tokens.map(({ id, label, createdAt, lastUsedAt }) => ({
    id, label, createdAt, lastUsedAt,
  }));
}

/* ------------------------------------------------------------------ *
 * Token values
 * ------------------------------------------------------------------ */

/**
 * `zlt_<id>_<43 chars of base64url>`.
 *
 * The id travels in the token on purpose. It costs nothing — knowing that a
 * token claims to be `t_9f3a1c` tells an attacker nothing they could not guess —
 * and it buys the ability to check exactly one candidate, which on macOS means
 * one keychain read per call instead of one per token per call.
 *
 * 32 bytes of `randomBytes` is the actual secret. That is the same entropy as
 * the session token, from the same CSPRNG.
 */
const TOKEN_PREFIX = 'zlt';
const TOKEN_RE = /^zlt_([a-z]{1,8}_[0-9a-f]{4,16})_([A-Za-z0-9_-]{22,128})$/;

function makeTokenValue(id) {
  return `${TOKEN_PREFIX}_${id}_${crypto.randomBytes(32).toString('base64url')}`;
}

/** Pull the token id out of a presented value, or null if it is not one of ours. */
export function tokenIdOf(presented) {
  if (typeof presented !== 'string') return null;
  const m = TOKEN_RE.exec(presented.trim());
  return m ? m[1] : null;
}

/**
 * Constant-time string comparison that does not leak length either: both sides
 * are hashed first, so `timingSafeEqual` always sees 32 bytes. The same shape
 * core/server.mjs uses for the session token, for the same reason.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** A value nothing will ever match, used to keep the failure path's cost even. */
const DECOY = `${TOKEN_PREFIX}_x_${crypto.randomBytes(32).toString('base64url')}`;

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function assertLabel(label) {
  const clean = cap(typeof label === 'string' ? label : '', MAX_LABEL_CHARS);
  if (!clean) throw new TypeError('a token needs a label — name the client it is for');
  return clean;
}

/**
 * Mint a token for one named client.
 *
 * Returns `{value, token, config}` and this is the **only** moment `value`
 * exists outside the secret store. Nothing persists it, nothing logs it, and
 * there is no route or function anywhere that can produce it again.
 *
 * The list the new record is appended to is re-read from disk after the store
 * write, not carried across it. A mint takes as long as the secret store does,
 * and a revocation that lands inside that window used to be undone by the save
 * at the end of it: the revoked record came back into config.json, and the
 * panel then listed a token the user had already thrown away. Appending to the
 * live list keeps both truths — the revocation and the new token.
 */
export async function mintToken({ label, config = loadConfig(), now = nowISO(), store = STORE } = {}) {
  const clean = assertLabel(label);
  if (aiConfig(config).tokens.length >= MAX_TOKENS) {
    throw new Error(`there are already ${MAX_TOKENS} tokens — revoke one before minting another`);
  }

  const id = newId('t');
  const ref = `ai.${id}`;
  const value = makeTokenValue(id);

  // The secret lands first. If this throws, config is untouched and there is no
  // token record pointing at a value that was never stored.
  await store.setSecret(ref, value);

  const token = { id, label: clean, ref, createdAt: now, lastUsedAt: null };
  let saved;
  try {
    const current = liveAi();
    // Checked again against the live list: two mints running side by side each
    // saw room, and the cap is a promise about what is on disk.
    if (current.tokens.length >= MAX_TOKENS) {
      throw new Error(`there are already ${MAX_TOKENS} tokens — revoke one before minting another`);
    }
    saved = saveConfig({ ai: { ...current, tokens: [...current.tokens, token] } });
  } catch (err) {
    forgetVerified(id);
    await store.deleteSecret(ref).catch(() => {});
    throw err;
  }

  log.info('ai: minted an access token', { id, label: clean });
  return { value, token: { id, label: clean, createdAt: now, lastUsedAt: null }, config: saved };
}

/**
 * Revoke a token: gone from the secret store, gone from config. Either half
 * alone would be enough to stop it working, and both are done anyway — a
 * credential nobody can use is still a credential sitting on the disk.
 *
 * The removal is applied to the list as it is on disk after the store call, not
 * to the caller's snapshot. Taking one id out of a stale array and saving the
 * array is how a revocation silently deleted a token minted while it ran: that
 * record vanished from config.json while its secret stayed in the store, which
 * is an orphan nobody can see to clean up.
 */
export async function revokeToken(id, { config = loadConfig(), store = STORE } = {}) {
  // First, before anything that can wait: a check that remembered this token
  // must not accept it while the store and the config catch up.
  forgetVerified(id);
  const token = aiConfig(config).tokens.find((t) => t.id === id)
    ?? liveAi().tokens.find((t) => t.id === id);
  if (!token) return { ok: true, revoked: false, config };

  try {
    await store.deleteSecret(token.ref);
  } catch (err) {
    // Config is still updated below: a token the app refuses to accept is
    // revoked as far as every caller is concerned, and leaving it listed would
    // tell the user a lie.
    log.warn('ai: could not remove a revoked token from the secret store', { id, error: err.message });
  }

  const current = liveAi();
  const saved = saveConfig({ ai: { ...current, tokens: current.tokens.filter((t) => t.id !== id) } });
  log.info('ai: revoked an access token', { id, label: token.label });
  return { ok: true, revoked: true, config: saved };
}

/**
 * Verify a presented bearer token.
 *
 * Order matters. The master switch is checked first, so a token cannot be used
 * to probe anything while AI access is off. Then the id is looked up in config,
 * the caller's and then the one on disk — which is what makes revocation
 * immediate — and only then is the stored value fetched and compared in
 * constant time. A digest remembered from an earlier
 * read stands in for that fetch only while the disk and the store both say
 * nothing has changed — see "What a token check remembers" above.
 *
 * Returns `{ok, token, reason}`. `token` is the config record (no value), and
 * `reason` is for the caller's own log, never for the response body: telling an
 * unauthenticated caller *why* it failed is telling it which half to fix.
 */
export async function verifyToken(presented, { config = loadConfig(), store = STORE, now = Date.now() } = {}) {
  const current = aiConfig(config);
  if (!current.enabled) return { ok: false, token: null, reason: 'ai-access-disabled' };

  const id = tokenIdOf(presented);
  const record = id ? current.tokens.find((t) => t.id === id) : null;
  if (!record) {
    // Run the comparison anyway so a near-miss and a hit cost the same to
    // compare. This does not hide *whether an id exists* — the store lookup on
    // the path below takes longer — and it is not meant to: token ids are
    // listed in the Settings panel and travel inside the token itself. The
    // secret is the 32 bytes after the id, and that is what is compared in
    // constant time.
    constantTimeEqual(typeof presented === 'string' ? presented : '', DECOY);
    return { ok: false, token: null, reason: id ? 'unknown-token' : 'malformed-token' };
  }

  // The caller's config may be a snapshot from before a revocation or a
  // switch-off — the HTTP layer holds one for the life of the process — so the
  // record and the switch are confirmed on disk before anything is believed or
  // read. That is what makes a revocation whose store delete failed (which
  // revokeToken tolerates) still a revocation.
  const key = verifiedKey(record);
  const live = liveAi();
  const liveRecord = live.tokens.find((t) => t.id === record.id && t.ref === record.ref);
  if (!live.enabled || !liveRecord) {
    verified.delete(key);
    constantTimeEqual(typeof presented === 'string' ? presented : '', DECOY);
    return { ok: false, token: null, reason: live.enabled ? 'unknown-token' : 'ai-access-disabled' };
  }

  const remembered = verified.get(key);
  if (remembered) {
    let version = null;
    try { version = await store.secretVersion(record.ref); } catch { /* not believed; read the store */ }
    if (version && verified.get(key) === remembered
        && now - remembered.at < VERIFIED_TTL_MS && now >= remembered.at
        && remembered.createdAt === liveRecord.createdAt
        && remembered.gen === version.gen && remembered.stamp === version.stamp) {
      // A mismatch here is answered without going back to the store: a stream
      // of wrong guesses at a real id must not become a stream of spawns.
      // The faster answer shows by timing that this token was used in the last
      // minute — only to a caller on loopback who already has its id. Accepted.
      if (!crypto.timingSafeEqual(sha256(presented.trim()), remembered.digest)) {
        return { ok: false, token: null, reason: 'mismatch' };
      }
      return { ok: true, token: publicRecord(liveRecord), reason: 'ok' };
    }
    verified.delete(key);
  }

  // Taken before the read, so a change during it shows up as a different
  // version next time rather than being remembered as current.
  const epoch = verifiedEpoch;
  let version = null;
  try { version = await store.secretVersion(record.ref); } catch { /* then nothing is remembered */ }
  let stored = null;
  try {
    stored = await store.getSecret(record.ref);
  } catch (err) {
    log.warn('ai: could not read a token from the secret store', { id: record.id, error: err.message });
  }
  if (!stored) {
    constantTimeEqual(presented, DECOY);
    return { ok: false, token: null, reason: 'no-stored-value' };
  }
  // Remembered after any read that found a value, matched or not, so a wrong
  // guess repeated at a real id costs one read, not one each.
  if (version && epoch === verifiedEpoch) {
    verified.set(key, {
      home: paths().home, id: liveRecord.id, digest: sha256(stored), createdAt: liveRecord.createdAt, at: now, gen: version.gen, stamp: version.stamp,
    });
  }
  if (!constantTimeEqual(presented.trim(), stored)) {
    return { ok: false, token: null, reason: 'mismatch' };
  }

  return { ok: true, token: publicRecord(liveRecord), reason: 'ok' };
}

function publicRecord(record) {
  return { id: record.id, label: record.label, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt };
}

/**
 * Record that a token was used. Called after a call succeeds, so "last used"
 * means "last worked" — a stream of rejected attempts must not make a revoked
 * client look alive in the panel.
 *
 * A save is an atomic rewrite with two fsyncs, and an AI client can fire several
 * tool calls a second, so a stamp that has not changed is not written: the
 * timestamp is second-resolution and rewriting the same value would be pure I/O.
 *
 * **The token list is re-read from disk, not taken from the caller's config.**
 * That is not tidiness, it is the fix for a hole that was open: a save writes
 * the whole `ai.tokens` array, and a request that started before a revocation
 * still holds the list as it was before. Letting that list win put the revoked
 * record straight back into config.json — the panel then listed a token the
 * user had revoked, and had `deleteSecret` failed (which `revokeToken`
 * tolerates, and only warns about) the credential would have worked again.
 * A token revoked mid-request stays revoked. `mintToken`, `revokeToken` and
 * `setAiSettings` do the same thing for the same reason; `liveAi` is the shared
 * name for it.
 */
export function touchToken(id, { config = loadConfig(), now = nowISO() } = {}) {
  const current = liveAi();
  const record = current.tokens.find((t) => t.id === id);
  if (!record) return config;
  if (record.lastUsedAt === now) return config;
  return saveConfig({
    ai: {
      ...current,
      tokens: current.tokens.map((t) => (t.id === id ? { ...t, lastUsedAt: now } : t)),
    },
  });
}

/**
 * Write the master switch and the scope toggles. Both are validated against the
 * closed set — an unknown scope key is refused rather than stored, because a
 * key nothing reads is a switch that looks like it does something and does not.
 *
 * Everything this call is not changing comes off the disk. A caller's config
 * snapshot no longer has a say: the HTTP layer holds one for the life of the
 * process and used to hand it here, which meant a flick of the master switch
 * wrote that snapshot's whole `ai` block back — putting a revoked token record,
 * or a scope another window had just switched off, straight into config.json.
 * `enabled` and `scopes` are the only things a caller gets to state. The old
 * second argument is still accepted and ignored, so existing callers are
 * unaffected.
 */
export function setAiSettings({ enabled, scopes } = {}) {
  const current = liveAi();
  const next = { ...current };

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be true or false');
    next.enabled = enabled;
    // Every check reads the switch from disk anyway; this keeps nothing
    // remembered across an off-and-on.
    if (!enabled) forgetVerified();
  }

  if (scopes !== undefined) {
    if (!isPlainObject(scopes)) throw new TypeError('scopes must be an object of scope keys to booleans');
    const unknown = Object.keys(scopes).filter((k) => !SCOPES.includes(k));
    if (unknown.length) throw new TypeError(`unknown scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    const merged = { ...current.scopes };
    for (const [key, value] of Object.entries(scopes)) {
      if (typeof value !== 'boolean') throw new TypeError(`scope ${key} must be true or false`);
      merged[key] = value;
    }
    next.scopes = merged;
  }

  return saveConfig({ ai: next });
}
