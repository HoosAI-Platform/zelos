/**
 * core/model-key.mjs — a model key belongs to the address it was saved for.
 *
 * There used to be one slot, `model.default`, and whatever sat in it went to
 * whichever AI service was chosen. Save a Claude key, choose OpenAI, press
 * "Check it works", and the Claude key went to api.openai.com — and to every
 * sweep after Save. Nothing tied the key to the service it was pasted for.
 *
 * Now the ref a model key is stored under is DERIVED from the address the
 * request goes to, and no caller ever names it. Reading a key for an address
 * can only return a key that was saved for that address, so switching services
 * cannot carry one across, and switching back finds the old one again.
 *
 *  - The address is canonicalised by the WHATWG URL parser, the same one fetch
 *    uses: case, default port, punycode and IPv4 spellings collapse, userinfo
 *    is dropped. The scheme stays, so a key saved for https://host never goes to
 *    http://host in the clear. The PATH stays too: AI gateways (Cloudflare,
 *    Azure APIM, Vercel) route one host to different companies by path, so
 *    `…/anthropic` and `…/openai` are different destinations.
 *  - The ref is always a hash. A readable one collides (`proxy:8443` against
 *    `proxy_8443`) and puts hostnames into logs and `secretRefs`; nobody reads
 *    these refs, because the UI no longer names them.
 *
 * Every read of a model key goes through readModelKey(). `config.model.keyRef`
 * is kept in config.json for older versions, and nothing here trusts it.
 */

import crypto from 'node:crypto';

import { PRESETS } from './llm.mjs';

/** The ref every model key lived under before keys were bound to addresses. */
export const LEGACY_MODEL_REF = 'model.default';

/**
 * Where a pre-upgrade key goes when no address can be trusted with it. Nothing
 * reads it for a request and nothing moves it on; doctor reports it, and
 * forgetting the configured service's key removes it. Left in `model.default`
 * instead, it would be handed to the next service chosen — this bug again.
 */
export const UNPLACED_MODEL_REF = 'model.unplaced';

/** True for any ref in the model namespace, which only the model may read. */
export function isModelKeyRef(ref) {
  return typeof ref === 'string' && (ref === 'model' || ref.startsWith('model.'));
}

/**
 * The canonical destination a key is bound to: scheme, host (with any
 * non-default port) and path without trailing slashes. Null for anything that
 * is not an http(s) address with a host — `localhost:1234` parses, as the
 * scheme `localhost:`, and must not be given a key slot.
 */
export function modelKeyDestination(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  let url;
  try { url = new URL(baseUrl.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || /^\.+$/.test(url.hostname)) return null;
  // `api.openai.com.` is the same host to DNS; its trailing dot is not a
  // different destination. A single label keeps it: `gateway.` and `gateway`
  // can be two machines once a search domain is applied.
  const host = /\..*\.(?::\d+)?$/.test(url.host) ? url.host.replace(/\.(?=(?::\d+)?$)/, '') : url.host;
  return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, '')}`;
}

/** The ref the key for this address is stored under, or null for no address. */
export function modelKeyRef(baseUrl) {
  const destination = modelKeyDestination(baseUrl);
  if (!destination) return null;
  return `model.o_${crypto.createHash('sha256').update(destination).digest('hex').slice(0, 32)}`;
}

/*
 * Key prefixes distinctive enough to name their company. They decide where a
 * pre-upgrade key goes when the configured address cannot be what it was for —
 * the people this bug already caught (a Claude key with OpenAI chosen). A
 * custom hosted address keeps the key whatever it looks like: a gateway in
 * front of Anthropic is given a Claude key on purpose. OpenAI's `sk-` is shared
 * with half the industry, so it is not here.
 */
const KEY_PREFIXES = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['gsk_', 'groq'],
  ['xai-', 'xai'],
  ['AIza', 'gemini'],
];

function presetFor(baseUrl) {
  const destination = modelKeyDestination(baseUrl);
  return destination ? PRESETS.find((p) => modelKeyDestination(p.baseUrl) === destination) || null : null;
}

/**
 * The address a pre-upgrade key should be bound to — normally the configured
 * one — or null when no address can be trusted with it (it is then set aside
 * under UNPLACED_MODEL_REF).
 *
 *  - A key whose prefix names a provider goes to that provider when the
 *    configured address is another provider's preset, keyless runtimes
 *    included (an `sk-ant-` key has no business at OpenAI or Ollama).
 *  - A key without the configured provider's own prefix is not given to it
 *    (an `sk-proj-` key with Anthropic chosen).
 *  - A keyless runtime is not given a key nobody can place.
 *  - Anything else — a custom address, a proxy on this network included —
 *    keeps it, as 1.9.5 sent it there: a proxy in front of Anthropic is given
 *    a Claude key on purpose.
 */
function legacyHome(key, configuredBaseUrl) {
  const configured = presetFor(configuredBaseUrl);
  const owner = KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? null;
  const ownerHome = owner ? PRESETS.find((p) => p.id === owner)?.baseUrl ?? null : null;
  if (configured?.id === owner) return configuredBaseUrl;
  if (ownerHome && configured) return ownerHome;
  if (configured && KEY_PREFIXES.some(([, id]) => id === configured.id)) return null;
  if (configured?.keyless) return null;
  return configuredBaseUrl;
}

/**
 * The key saved for `baseUrl`, or null. The only way any code reads a model key.
 *
 * It also moves a pre-upgrade `model.default` key, lazily, the first time the
 * CONFIGURED address is read — at whichever read comes first (Settings, a
 * sweep, Ask, doctor), so there is no launch ordering to get wrong. There is no
 * "done" flag: restoring an old backup brings `model.default` back, and it is
 * moved again. The move is copy-then-delete; a run that copied and then failed
 * to delete finishes the delete next time, when the copy holds the same value.
 * `setSecret`/`deleteSecret` are optional: without them the legacy key is
 * neither moved nor returned, so a caller with a fake store never writes to the
 * real one.
 */
export async function readModelKey(baseUrl, { getSecret, setSecret = null, deleteSecret = null, configuredBaseUrl = null, log = null } = {}) {
  const ref = modelKeyRef(baseUrl);
  if (!ref) return null;
  const key = await getSecret(ref);
  if (typeof key === 'string' && key) {
    if (setSecret && deleteSecret && modelKeyDestination(baseUrl) === modelKeyDestination(configuredBaseUrl)) {
      await finishHalfMove(key, ref, { getSecret, deleteSecret, log });
    }
    return key;
  }
  if (!setSecret || !deleteSecret) return null;
  if (modelKeyDestination(baseUrl) !== modelKeyDestination(configuredBaseUrl)) return null;

  let legacy = null;
  try { legacy = await getSecret(LEGACY_MODEL_REF); } catch { return null; }
  if (typeof legacy !== 'string' || !legacy) return null;

  const home = modelKeyRef(legacyHome(legacy, configuredBaseUrl));
  try {
    const existing = home ? await getSecret(home) : null;
    if (home && !existing) await setSecret(home, legacy);
    // No address can take it, or a different key is already saved for its
    // address and wins: it is set aside, not thrown away and not left where
    // the next service chosen would be handed it.
    if (!home || (existing && existing !== legacy)) {
      await setSecret(UNPLACED_MODEL_REF, legacy);
      await deleteSecret(LEGACY_MODEL_REF);
      log?.info?.('model key: set aside a saved key no address could take');
      return null;
    }
    await deleteSecret(LEGACY_MODEL_REF);
    log?.info?.('model key: moved the saved key to the address it is for', { ref: home });
  } catch (err) {
    log?.warn?.('model key: could not move the saved key', { error: err?.message });
    return null;
  }
  return home === ref ? legacy : null;
}

/* Refs already checked for a leftover `model.default` in this process. The
   check reads the store, and a sweep should not pay for it every half hour. */
const halfMoveChecked = new WeakMap();

async function finishHalfMove(key, ref, { getSecret, deleteSecret, log }) {
  const seen = halfMoveChecked.get(getSecret) ?? new Set();
  halfMoveChecked.set(getSecret, seen);
  if (seen.has(ref)) return;
  try {
    if ((await getSecret(LEGACY_MODEL_REF)) === key) await deleteSecret(LEGACY_MODEL_REF);
    seen.add(ref);
  } catch (err) {
    log?.warn?.('model key: could not remove the old key slot', { error: err?.message });
  }
}
