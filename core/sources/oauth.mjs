/**
 * core/sources/oauth.mjs — OAuth 2.0 Authorization Code + PKCE, loopback redirect.
 *
 * Built and tested. The calendar half is still inert; the mail half is live.
 *
 * Zelos is a desktop app, so it is a *public* client: whatever secret you shipped
 * with it would be sitting in every copy of the tarball. The flow that is correct
 * for a public client is RFC 8252 — Authorization Code with PKCE (RFC 7636) and a
 * redirect back to a loopback listener. The one place a `client_secret` is sent
 * is the token endpoint, and only for Google's mail sign-in: Google issues its
 * "Desktop app" clients a secret and requires it at `/token`, while documenting
 * that it is not confidential for an installed app. It is an explicit argument,
 * read from the secret store by the caller, never a parameter a request body
 * could ride in on.
 *
 * Three properties this module holds, all of them tested:
 *
 *  1. **Nothing dials out without a client id.** `DEFAULT_OAUTH_CLIENTS` is blank
 *     until Zelos's own registrations exist, `config.oauth.clients.<provider>`
 *     overrides it, and every entry point refuses with `not_configured` when
 *     `oauthClient()` finds neither.
 *  2. **Calendar stays read-only.** Each provider's `allowedScopes` is a closed
 *     calendar-only set and `assertScopes` refuses anything outside it. Mail is a
 *     separate, equally closed list — `mailScopes`, Google only — that a caller
 *     has to ask for by name (`purpose: 'mail'`), so the calendar path cannot
 *     widen into the mailbox by accident and the mail path is the one row
 *     core/server.mjs's "Sign in with Google" reads. Microsoft's mail sign-in is
 *     the device grant in core/sources/imap.mjs §6 and does not pass through here.
 *  3. **Refresh tokens live in the secret store.** `core/secrets.mjs`, same as every
 *     other credential — never `config.json`, never a log line, never argv.
 *
 * The `state` check is the one thing here that is a security control rather than
 * plumbing, so it is worth saying what it defends: anything on this machine can
 * send a GET to a loopback port. Without `state`, a page in the user's browser
 * could hand Zelos an authorization code belonging to *the attacker's* account and
 * Zelos would happily bind it. So the receiver compares the returned `state`
 * against the one it minted, in constant time, and a mismatch fails the flow —
 * it never becomes a token request.
 */

import crypto from 'node:crypto';
import http from 'node:http';

import { log } from '../log.mjs';
import { getSecret, setSecret, deleteSecret } from '../secrets.mjs';
import { isModelKeyRef } from '../model-key.mjs';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * `code` is the machine-readable reason: `not_configured`, `state_mismatch`,
 * `denied`, `timeout`, `closed`, `bad_scope`, `token_error`, `http_<status>`, or
 * whatever `error` the authorization server itself returned.
 */
export class OAuthError extends Error {
  constructor(message, { code = 'oauth_error', provider = '', status = 0, description = '' } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.description = description;
  }
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/**
 * Two providers, calendar only.
 *
 * `allowedScopes` is a closed set rather than a suggestion. A caller may ask for
 * fewer, never for more, and the check is what makes "Zelos cannot request your
 * mail" a property of the code instead of a promise in a README.
 *
 * `registerUrl` and `note` exist so Settings can tell the truth about what the
 * user would have to do before any of this does anything at all.
 */
export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: 'google',
    label: 'Google Calendar',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
    /** Asking for a refresh token on Google is opt-in, twice over. */
    authParams: Object.freeze({ access_type: 'offline', prompt: 'consent' }),
    defaultScopes: Object.freeze(['https://www.googleapis.com/auth/calendar.readonly']),
    allowedScopes: Object.freeze([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'openid',
      'email',
      'profile',
    ]),
    /**
     * The one scope that opens IMAP. Full mailbox access is what Google grants
     * for `AUTHENTICATE XOAUTH2`; there is no narrower scope the IMAP server
     * accepts. Kept apart from `allowedScopes` so the calendar path cannot
     * reach it — see `assertScopes`.
     */
    mailScopes: Object.freeze(['https://mail.google.com/']),
    /** RFC 8252 loopback. Google matches the host exactly and ignores the port. */
    loopbackHost: '127.0.0.1',
    redirectPath: '/oauth/google',
    registerUrl: 'https://console.cloud.google.com/apis/credentials',
    note:
      'Calendar read is a sensitive scope: Google requires app verification — a demo video, '
      + 'a published privacy policy and a verified domain, about ten days. There is no CASA '
      + 'assessment and no annual fee for this scope. Until a client id from your own Google '
      + 'Cloud project is pasted in, this path does nothing.',
  }),
  microsoft: Object.freeze({
    id: 'microsoft',
    label: 'Microsoft Graph Calendar',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    apiBaseUrl: 'https://graph.microsoft.com/v1.0',
    authParams: Object.freeze({ response_mode: 'query' }),
    defaultScopes: Object.freeze(['offline_access', 'Calendars.Read']),
    allowedScopes: Object.freeze([
      'offline_access',
      'openid',
      'profile',
      'email',
      'User.Read',
      'Calendars.Read',
      'Calendars.Read.Shared',
    ]),
    loopbackHost: '127.0.0.1',
    redirectPath: '/oauth/microsoft',
    registerUrl: 'https://entra.microsoft.com/',
    note:
      'Needs a multi-tenant app registration in Microsoft Entra, registered as a desktop '
      + 'client with a loopback redirect, plus publisher verification (a Partner One ID and a '
      + 'verified domain) before anyone outside your own tenant can consent. There is no CASA '
      + 'equivalent. Until a client id is pasted in, this path does nothing.',
  }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/** Never wired, and the tests assert it stays that way. */
export const NOT_WIRED = Object.freeze({
  gmail: 'Gmail read is a restricted scope (CASA Tier 2, re-assessed annually). IMAP is the supported mail path.',
});

export function providerFor(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return Object.hasOwn(PROVIDERS, key) ? PROVIDERS[key] : null;
}

function requireProvider(id) {
  const provider = providerFor(id);
  if (!provider) {
    throw new OAuthError(
      `oauth: unknown provider ${JSON.stringify(id)} — Zelos wires ${PROVIDER_IDS.join(' and ')} only`,
      { code: 'unknown_provider', provider: String(id ?? '') },
    );
  }
  return provider;
}

/** What Settings shows: enough to decide whether this is worth starting. */
export function describeProvider(id) {
  const p = requireProvider(id);
  return {
    id: p.id,
    label: p.label,
    scopes: [...p.defaultScopes],
    allowedScopes: [...p.allowedScopes],
    registerUrl: p.registerUrl,
    note: p.note,
    redirectExample: `http://${p.loopbackHost}:<port>${p.redirectPath}`,
  };
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * `core/config.mjs` owns DEFAULTS and this module does not edit it, so the
 * defaults for the block live here and are merged on read. A config that has
 * never heard of OAuth therefore reads as "blank client id, disabled", which is
 * exactly the inert state.
 */
export const OAUTH_DEFAULTS = Object.freeze({
  google: Object.freeze({ enabled: false, clientId: '', accountId: 'default' }),
  microsoft: Object.freeze({ enabled: false, clientId: '', accountId: 'default' }),
});

/** -> {enabled, clientId, accountId, configured} */
export function oauthSettings(config, providerId) {
  const p = requireProvider(providerId);
  const base = OAUTH_DEFAULTS[p.id];
  const raw = (config && typeof config === 'object' && config.oauth && typeof config.oauth === 'object')
    ? config.oauth[p.id]
    : null;
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const clientId = typeof merged.clientId === 'string' ? merged.clientId.trim() : '';
  const accountId = typeof merged.accountId === 'string' && merged.accountId.trim() ? merged.accountId.trim() : 'default';
  return {
    enabled: merged.enabled === true,
    clientId,
    accountId,
    configured: clientId.length > 0,
  };
}

/** True when a registration exists. Nothing dials out until this is true. */
export function isConfigured(config, providerId) {
  return oauthSettings(config, providerId).configured;
}

/**
 * The honest sentence for the UI, or null when the path is live. Settings
 * renders this verbatim rather than inventing its own wording.
 */
export function inertNote(config, providerId) {
  const p = requireProvider(providerId);
  const s = oauthSettings(config, providerId);
  if (!s.configured) {
    return `${p.label} is built but inert: there is no client id in this config, so Zelos will not contact anyone. ${p.note}`;
  }
  if (!s.enabled) {
    return `${p.label} has a client id but is switched off. Nothing is fetched until you turn it on.`;
  }
  return null;
}

/**
 * Refs are what `core/secrets.mjs` stores under, and they must satisfy its
 * charset (letters, digits, dot, underscore, hyphen).
 */
export function tokenRef(providerId, accountId = 'default') {
  const p = requireProvider(providerId);
  const account = String(accountId ?? 'default').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  return `oauth.${p.id}.${account}`;
}

/* ------------------------------------------------------------------ *
 * The mail sign-in clients
 * ------------------------------------------------------------------ */

/**
 * Where Google sends the browser back: a fixed path on the Zelos server itself,
 * not a second listener. The server already owns a loopback port, and a
 * "Desktop app" client at Google accepts `http://127.0.0.1:<any port>/<path>`,
 * so the redirect is whatever port Zelos actually bound plus this.
 */
export const MAIL_CALLBACK_PATH = '/oauth/callback';

/**
 * Where a user-supplied Google client secret is filed. A ref, like every other
 * credential: config.json carries at most this NAME, never the value —
 * core/config.mjs's `stripSecrets` deletes a `clientSecret` key at any depth on
 * every save, so there is no way to store it there even by accident.
 */
export const GOOGLE_CLIENT_SECRET_REF = 'oauth.google.clientSecret';

/**
 * Where the secret for the Google client a sign-in actually ran against is
 * filed. The client from config or the shipped default keeps the install-wide
 * ref above — or the name the operator chose — so nothing moves for an
 * install with one registered client. A clientId PASTED into a sign-in form
 * is a different Cloud project, and filing its secret under the install-wide
 * name would overwrite the configured client's: the next refresh would then
 * present one project's id with the other's secret, and Google answers
 * `invalid_client` an hour after the card said "Connected". Derived from the
 * id alone — hashed, because a client id is longer than a ref may be — so
 * the connect that files the secret and the refresh that spends it can never
 * disagree about the name.
 */
export function googleSecretRefFor(client, clientId = '') {
  const id = String(clientId ?? '').trim();
  if (!id || id === client?.clientId) return client?.clientSecretRef || GOOGLE_CLIENT_SECRET_REF;
  const tag = crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
  return `${GOOGLE_CLIENT_SECRET_REF}.${tag}`;
}

/**
 * The client ids Zelos ships for "Sign in with Google" and "Sign in with
 * Microsoft". Blank until Zelos's own registrations exist — the Google Cloud
 * project is in Testing and the Entra registration is unverified — at which
 * point these two strings are the only edit: the flow is already built to be
 * byte-identical on either side of that day. While they are blank,
 * `config.oauth.clients.<provider>.clientId` is how the operator's own
 * registration is used.
 */
export const DEFAULT_OAUTH_CLIENTS = Object.freeze({
  google: Object.freeze({ clientId: '' }),
  microsoft: Object.freeze({ clientId: '', tenantId: 'common' }),
});

/**
 * Which client a mail sign-in runs against, and where it came from.
 *
 * `source` is the answer to "will this work without the user registering
 * anything": `config` when the operator pasted one in, `default` when Zelos
 * ships one, `none` when neither — which is what POST /api/mail/guess reports
 * as `clientReady: false`. Google's `clientSecretRef` is the NAME of the ref the
 * secret may live under; whether anything is stored there is the secret
 * store's business, and a client without one is still a working client.
 */
export function oauthClient(config, providerId) {
  const p = requireProvider(providerId);
  const clients = (config && typeof config === 'object' && config.oauth && typeof config.oauth === 'object'
    && config.oauth.clients && typeof config.oauth.clients === 'object')
    ? config.oauth.clients[p.id]
    : null;
  const own = clients && typeof clients === 'object' ? clients : {};
  const shipped = DEFAULT_OAUTH_CLIENTS[p.id];
  const configured = typeof own.clientId === 'string' ? own.clientId.trim() : '';
  const clientId = configured || shipped.clientId;
  const out = { clientId, source: configured ? 'config' : (shipped.clientId ? 'default' : 'none') };
  if (p.id === 'microsoft') {
    const tenant = typeof own.tenantId === 'string' ? own.tenantId.trim() : '';
    out.tenantId = tenant || shipped.tenantId;
  }
  if (p.id === 'google') {
    const ref = typeof own.clientSecretRef === 'string' ? own.clientSecretRef.trim() : '';
    // Never an AI key's slot: the client secret is posted to Google, and a
    // sign-in that brings one stores it here (core/model-key.mjs).
    out.clientSecretRef = ref && !isModelKeyRef(ref) ? ref : GOOGLE_CLIENT_SECRET_REF;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

export const CODE_CHALLENGE_METHOD = 'S256';

/**
 * RFC 7636 §4.1: 43–128 characters from the unreserved set. 32 random bytes
 * base64url-encoded is 43 characters with no padding — the minimum length and
 * the full 256 bits, which is the point.
 */
export function createVerifier(bytes = 32) {
  const n = Number(bytes);
  if (!Number.isInteger(n) || n < 32 || n > 96) {
    throw new TypeError('oauth: a PKCE verifier needs 32–96 bytes of entropy');
  }
  return crypto.randomBytes(n).toString('base64url');
}

/** RFC 7636 §4.2: BASE64URL(SHA256(ASCII(verifier))), no padding. */
export function challengeFor(verifier) {
  const v = String(verifier ?? '');
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(v)) {
    throw new TypeError('oauth: a PKCE verifier must be 43–128 unreserved characters');
  }
  return crypto.createHash('sha256').update(v, 'ascii').digest('base64url');
}

/** The anti-CSRF nonce that ties a callback to the request that started it. */
export function createState() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant time, and false for anything that is not two equal-length strings. */
export function statesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * The authorization URL
 * ------------------------------------------------------------------ */

/**
 * Refuse any scope outside the provider's allowlist for the stated purpose.
 *
 * This is the mechanism that keeps "calendar, read-only" structural: there is
 * no argument to `authorize()` that widens it. `purpose: 'mail'` switches to
 * the provider's `mailScopes` — a different closed list, not a superset — so a
 * mail sign-in cannot ask for the calendar and a calendar sign-in cannot ask
 * for the mailbox. Adding a scope to either means editing `PROVIDERS` in a diff
 * somebody has to look at.
 */
export function assertScopes(provider, scopes, { purpose = 'calendar' } = {}) {
  const p = typeof provider === 'string' ? requireProvider(provider) : provider;
  if (purpose !== 'calendar' && purpose !== 'mail') {
    throw new OAuthError(`oauth: unknown purpose ${JSON.stringify(purpose)}`, { code: 'bad_scope', provider: p.id });
  }
  const wanted = (Array.isArray(scopes) ? scopes : [scopes])
    .flatMap((s) => String(s ?? '').split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) {
    throw new OAuthError('oauth: at least one scope is required', { code: 'bad_scope', provider: p.id });
  }
  const list = purpose === 'mail' ? (p.mailScopes || []) : p.allowedScopes;
  if (!list.length) {
    throw new OAuthError(`oauth: ${p.label} has no ${purpose} scopes wired`, { code: 'bad_scope', provider: p.id });
  }
  const allowed = new Map(list.map((s) => [s.toLowerCase(), s]));
  const refused = wanted.filter((s) => !allowed.has(s.toLowerCase()));
  if (refused.length) {
    throw new OAuthError(
      `oauth: ${p.label} is wired for ${purpose === 'mail' ? 'mail' : 'calendar read'} only; refusing scope ${refused.join(', ')}`,
      { code: 'bad_scope', provider: p.id },
    );
  }
  // Normalise to the provider's own spelling, and de-duplicate.
  return [...new Set(wanted.map((s) => allowed.get(s.toLowerCase())))];
}

/**
 * Build the URL the user's browser is sent to. Everything in it comes from this
 * file or from the caller's own PKCE material — nothing from a mail message, a
 * model, or a remote response.
 */
export function buildAuthUrl({
  provider,
  clientId,
  redirectUri,
  state,
  challenge,
  scopes = null,
  loginHint = '',
  authorizeUrl = null,
  extra = null,
  purpose = 'calendar',
} = {}) {
  const p = typeof provider === 'string' ? requireProvider(provider) : requireProvider(provider?.id);
  const id = String(clientId ?? '').trim();
  if (!id) {
    throw new OAuthError(`oauth: ${p.label} has no client id, so there is nothing to authorize against`, {
      code: 'not_configured',
      provider: p.id,
    });
  }
  if (!redirectUri) throw new TypeError('oauth: buildAuthUrl needs a redirectUri');
  if (!state) throw new TypeError('oauth: buildAuthUrl needs a state');
  if (!challenge) throw new TypeError('oauth: buildAuthUrl needs a PKCE challenge');

  const url = new URL(authorizeUrl || p.authorizeUrl);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', id);
  params.set('redirect_uri', redirectUri);
  const defaults = purpose === 'mail' ? p.mailScopes : p.defaultScopes;
  params.set('scope', assertScopes(p, scopes ?? defaults, { purpose }).join(' '));
  params.set('state', state);
  params.set('code_challenge', challenge);
  params.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  for (const [k, v] of Object.entries(p.authParams)) params.set(k, v);
  if (loginHint) params.set('login_hint', String(loginHint));
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== null && v !== undefined) params.set(k, String(v));
  }
  // A public client has no secret, and no caller may smuggle one in.
  params.delete('client_secret');
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * The loopback receiver
 * ------------------------------------------------------------------ */

const RECEIVER_TIMEOUT_MS = 5 * 60_000;

/** Static pages. Nothing from the query string is ever echoed into them. */
const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Connected</title>
<style>body{background:#0b0d10;color:#e8e6e3;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{margin:0;color:#a6a29d}</style>
<main><h1>Zelos is connected.</h1><p>You can close this tab and go back to the app.</p></main>`;

const PAGE_REFUSED = `<!doctype html><meta charset="utf-8"><title>Refused</title>
<style>body{background:#0b0d10;color:#e8e6e3;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{margin:0;color:#a6a29d}</style>
<main><h1>Zelos refused that callback.</h1><p>It did not match the request Zelos started, so nothing was exchanged. Start the connection again from Settings.</p></main>`;

function sendPage(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  res.end(body);
}

function hostIsLoopback(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Bind an ephemeral port on 127.0.0.1 and wait for exactly one callback.
 *
 * Resolves as soon as the socket is listening, with `{ port, redirectUri,
 * waitForCode(), close() }`. `waitForCode()` settles once:
 *
 *   - resolves `{ code, state }` when the callback matches the state we minted;
 *   - rejects `state_mismatch` when it does not — the code is discarded unread,
 *     because a code that arrived under someone else's state is someone else's;
 *   - rejects with the provider's own error code when the user declines;
 *   - rejects `timeout` after `timeoutMs`, or `closed` if `close()` comes first.
 */
export async function startLoopbackReceiver({
  providerId,
  state,
  host = '127.0.0.1',
  port = 0,
  path: redirectPath = null,
  timeoutMs = RECEIVER_TIMEOUT_MS,
} = {}) {
  const p = requireProvider(providerId);
  if (!state) throw new TypeError('oauth: the loopback receiver needs the state it should expect');
  const wantPath = redirectPath || p.redirectPath;

  let settle;
  const result = new Promise((resolve, reject) => {
    let done = false;
    settle = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(value);
    };
  });
  // Nothing may observe an unhandled rejection between binding and the caller
  // reaching waitForCode(); the real handler is attached below.
  result.catch(() => {});

  const sockets = new Set();

  const server = http.createServer((req, res) => {
    // Loopback only, same reasoning as core/server.mjs: a name that is not this
    // machine means somebody re-pointed DNS at us.
    if (!hostIsLoopback(req.headers.host)) {
      sendPage(res, 403, PAGE_REFUSED);
      return;
    }
    // A top-level browser navigation carries no Origin. One that does is a page
    // scripting us, and a page has no business completing an OAuth flow.
    if (req.headers.origin) {
      sendPage(res, 403, PAGE_REFUSED);
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Length': 0, Connection: 'close' });
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      sendPage(res, 400, PAGE_REFUSED);
      return;
    }
    if (url.pathname !== wantPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('not found');
      return;
    }

    const got = url.searchParams;
    const returnedState = got.get('state') || '';

    // The state check comes before anything reads `code`. A mismatch is not a
    // "wrong page" — it is somebody trying to bind their account to this app.
    if (!statesMatch(returnedState, state)) {
      sendPage(res, 400, PAGE_REFUSED);
      log.warn('oauth: refused a callback whose state did not match', { provider: p.id });
      settle(new OAuthError(
        `oauth: the ${p.label} callback carried a state Zelos did not issue; nothing was exchanged`,
        { code: 'state_mismatch', provider: p.id },
      ));
      return;
    }

    const error = got.get('error');
    if (error) {
      sendPage(res, 400, PAGE_REFUSED);
      settle(new OAuthError(
        `oauth: ${p.label} refused the request (${String(error).slice(0, 80)})`,
        {
          code: String(error).slice(0, 80) || 'denied',
          provider: p.id,
          description: String(got.get('error_description') || '').slice(0, 300),
        },
      ));
      return;
    }

    const code = got.get('code') || '';
    if (!code) {
      sendPage(res, 400, PAGE_REFUSED);
      settle(new OAuthError(`oauth: the ${p.label} callback carried no authorization code`, {
        code: 'no_code',
        provider: p.id,
      }));
      return;
    }

    sendPage(res, 200, PAGE_OK);
    settle(null, { code, state: returnedState });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const bound = server.address();
  const redirectUri = `http://${host}:${bound.port}${wantPath}`;

  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => settle(new OAuthError(
      `oauth: nothing came back from ${p.label} within ${Math.round(timeoutMs / 1000)}s`,
      { code: 'timeout', provider: p.id },
    )), timeoutMs)
    : null;
  timer?.unref?.();

  const shutdown = () => {
    if (timer) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  // Whichever way the flow ends, the port goes away with it.
  const closed = result.then(
    async (v) => { await shutdown(); return v; },
    async (err) => { await shutdown(); throw err; },
  );
  closed.catch(() => {});

  return {
    provider: p.id,
    port: bound.port,
    host,
    path: wantPath,
    redirectUri,
    waitForCode: () => closed,
    close: async () => {
      settle(new OAuthError('oauth: the connection was cancelled', { code: 'closed', provider: p.id }));
      await shutdown();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The token endpoint
 * ------------------------------------------------------------------ */

const TOKEN_TIMEOUT_MS = 30_000;

function signalFor(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || TOKEN_TIMEOUT_MS));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postForm(url, form, { fetchImpl, timeoutMs, signal, provider, clientSecret = '' }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams(form);
  // Structural, not decorative: whatever was in `form`, the only secret that
  // goes out is the one the caller named as such — read from the secret store,
  // never from a request body or a config file.
  body.delete('client_secret');
  if (typeof clientSecret === 'string' && clientSecret) body.set('client_secret', clientSecret);

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: signalFor(timeoutMs, signal),
      redirect: 'error',
    });
  } catch (err) {
    throw new OAuthError(`oauth: could not reach the token endpoint at ${url} (${err.message})`, {
      code: err?.name === 'TimeoutError' ? 'timeout' : 'network',
      provider,
    });
  }

  const text = await res.text().catch(() => '');
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const code = String(payload?.error || `http_${res.status}`).slice(0, 80);
    const description = String(payload?.error_description || '').slice(0, 300);
    throw new OAuthError(
      `oauth: the token endpoint refused the request (${code}${description ? `: ${description}` : ''})`,
      { code, provider, status: res.status, description },
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new OAuthError('oauth: the token endpoint answered with something that was not JSON', {
      code: 'bad_response',
      provider,
      status: res.status,
    });
  }
  if (!payload.access_token) {
    throw new OAuthError('oauth: the token endpoint answered without an access token', {
      code: 'bad_response',
      provider,
      status: res.status,
    });
  }
  return payload;
}

/**
 * Normalised token set. `expiresAt` is an instant (UTC), not a wall-clock
 * reading — it is only ever compared, never displayed on a calendar.
 */
function normalizeTokens(payload, { now = Date.now(), previous = null } = {}) {
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: String(payload.access_token),
    // Google returns a refresh token once, on the first consent. A refresh that
    // omits it means "keep the one you have", not "you no longer have one".
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : (previous?.refreshToken ?? null),
    tokenType: String(payload.token_type || 'Bearer'),
    scope: typeof payload.scope === 'string' && payload.scope ? payload.scope : (previous?.scope ?? ''),
    expiresAt: Number.isFinite(expiresIn) ? new Date(now + expiresIn * 1000).toISOString() : null,
    obtainedAt: new Date(now).toISOString(),
  };
}

/**
 * Trade the authorization code for tokens. PKCE verifier instead of a secret —
 * plus the secret, when the registration has one: Google's "Desktop app"
 * clients are refused at `/token` without it, PKCE or not.
 */
export async function exchangeCode({
  provider,
  clientId,
  clientSecret = '',
  code,
  verifier,
  redirectUri,
  tokenUrl = null,
  fetchImpl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  now = Date.now(),
} = {}) {
  const p = typeof provider === 'string' ? requireProvider(provider) : requireProvider(provider?.id);
  const id = String(clientId ?? '').trim();
  if (!id) throw new OAuthError(`oauth: ${p.label} has no client id`, { code: 'not_configured', provider: p.id });
  if (!code) throw new TypeError('oauth: exchangeCode needs the authorization code');
  if (!verifier) throw new TypeError('oauth: exchangeCode needs the PKCE verifier');
  if (!redirectUri) throw new TypeError('oauth: exchangeCode needs the redirect URI the code came back to');

  const payload = await postForm(tokenUrl || p.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: id,
    code: String(code),
    code_verifier: String(verifier),
    redirect_uri: String(redirectUri),
  }, { fetchImpl, timeoutMs, signal, provider: p.id, clientSecret });

  log.info('oauth: exchanged an authorization code', { provider: p.id });
  return normalizeTokens(payload, { now });
}

/** Spend the refresh token for a new access token. */
export async function refreshTokens({
  provider,
  clientId,
  clientSecret = '',
  refreshToken,
  scopes = null,
  tokenUrl = null,
  fetchImpl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  now = Date.now(),
  previous = null,
} = {}) {
  const p = typeof provider === 'string' ? requireProvider(provider) : requireProvider(provider?.id);
  const id = String(clientId ?? '').trim();
  if (!id) throw new OAuthError(`oauth: ${p.label} has no client id`, { code: 'not_configured', provider: p.id });
  if (!refreshToken) {
    throw new OAuthError(`oauth: there is no ${p.label} refresh token stored; the account has to be connected again`, {
      code: 'no_refresh_token',
      provider: p.id,
    });
  }

  const form = {
    grant_type: 'refresh_token',
    client_id: id,
    refresh_token: String(refreshToken),
  };
  if (scopes) form.scope = assertScopes(p, scopes).join(' ');

  const payload = await postForm(tokenUrl || p.tokenUrl, form, {
    fetchImpl, timeoutMs, signal, provider: p.id, clientSecret,
  });

  log.info('oauth: refreshed an access token', { provider: p.id });
  return normalizeTokens(payload, { now, previous: previous || { refreshToken: String(refreshToken) } });
}

/* ------------------------------------------------------------------ *
 * The secret store
 * ------------------------------------------------------------------ */

/**
 * One JSON blob per account, in the OS keychain (or the encrypted fallback).
 * `config.json` gets the ref and nothing else — same contract as every other
 * credential in this app.
 */
export async function saveTokens(ref, tokens) {
  if (!tokens || typeof tokens !== 'object') throw new TypeError('oauth: saveTokens needs a token set');
  // JSON.stringify escapes any newline inside a value, so the stored string is
  // always single-line — which the macOS keychain backend requires.
  await setSecret(ref, JSON.stringify({
    v: 1,
    accessToken: tokens.accessToken ?? '',
    refreshToken: tokens.refreshToken ?? null,
    tokenType: tokens.tokenType ?? 'Bearer',
    scope: tokens.scope ?? '',
    expiresAt: tokens.expiresAt ?? null,
    obtainedAt: tokens.obtainedAt ?? new Date().toISOString(),
  }));
  return { ok: true, ref };
}

export async function loadTokens(ref) {
  const raw = await getSecret(ref);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    log.warn('oauth: the stored token blob could not be parsed', { ref });
    return null;
  }
}

export async function forgetTokens(ref) {
  return deleteSecret(ref);
}

/** Treat a token as spent a minute early, so a call never races its own expiry. */
export function tokensExpired(tokens, { now = Date.now(), skewMs = 60_000 } = {}) {
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return false;
  const at = Date.parse(tokens.expiresAt);
  if (Number.isNaN(at)) return false;
  return at - skewMs <= now;
}

/* ------------------------------------------------------------------ *
 * The whole flow
 * ------------------------------------------------------------------ */

/**
 * This module never opens a browser.
 *
 * Spawning a process is deliberately confined to `core/secrets.mjs` (the
 * keychain) and `zelos.mjs` (the launcher), and `test/security.test.mjs` holds
 * that line. So `authorize()` takes the opener as an argument, and what this file
 * contributes is the check the opener should be run through: the only URL Zelos
 * will hand to a browser is one of the authorization endpoints named in
 * PROVIDERS above — or an origin the caller explicitly asked for, which is how a
 * test points the flow at a local mock.
 */
export function assertOpenable(url, { extraOrigins = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError('oauth: refusing to open something that is not a URL', { code: 'bad_endpoint' });
  }
  const named = new Set(extraOrigins.filter(Boolean).map((o) => {
    try { return new URL(o).origin; } catch { return null; }
  }).filter(Boolean));
  if (named.has(parsed.origin)) return parsed.toString();

  const known = new Set(PROVIDER_IDS.map((id) => new URL(PROVIDERS[id].authorizeUrl).origin));
  if (parsed.protocol !== 'https:' || !known.has(parsed.origin)) {
    throw new OAuthError(`oauth: refusing to open ${parsed.origin} — it is not an authorization endpoint Zelos knows`, {
      code: 'bad_endpoint',
    });
  }
  return parsed.toString();
}

/**
 * Step one: mint the PKCE material, bind the loopback port, build the URL.
 *
 * Returns before anything is opened, so the caller can show the URL (some
 * people want to paste it into a different browser profile) and so a test can
 * drive the callback itself.
 */
export async function beginAuthorization({
  config = null,
  providerId,
  clientId = null,
  scopes = null,
  loginHint = '',
  authorizeUrl = null,
  host = '127.0.0.1',
  port = 0,
  timeoutMs = RECEIVER_TIMEOUT_MS,
} = {}) {
  const p = requireProvider(providerId);
  const settings = config ? oauthSettings(config, p.id) : null;
  const id = String(clientId ?? settings?.clientId ?? '').trim();
  if (!id) {
    throw new OAuthError(
      `${p.label} is built but inert: no client id is configured, so Zelos will not contact anyone. ${p.note}`,
      { code: 'not_configured', provider: p.id },
    );
  }

  const verifier = createVerifier();
  const challenge = challengeFor(verifier);
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: p.id, state, host, port, timeoutMs });

  let url;
  try {
    url = buildAuthUrl({
      provider: p,
      clientId: id,
      redirectUri: receiver.redirectUri,
      state,
      challenge,
      scopes: scopes ?? p.defaultScopes,
      loginHint,
      authorizeUrl,
    });
  } catch (err) {
    await receiver.close().catch(() => {});
    throw err;
  }

  return {
    provider: p.id,
    clientId: id,
    url,
    state,
    verifier,
    challenge,
    redirectUri: receiver.redirectUri,
    port: receiver.port,
    receiver,
    cancel: () => receiver.close(),
  };
}

/**
 * Step two: wait for the callback, then trade the code for tokens. The verifier
 * never leaves this process except in that one POST.
 */
export async function finishAuthorization(pending, {
  tokenUrl = null,
  fetchImpl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  now = Date.now(),
} = {}) {
  if (!pending?.receiver) throw new TypeError('oauth: finishAuthorization needs the handle beginAuthorization returned');
  const { code } = await pending.receiver.waitForCode();
  return exchangeCode({
    provider: pending.provider,
    clientId: pending.clientId,
    code,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
    tokenUrl,
    fetchImpl,
    timeoutMs,
    signal,
    now,
  });
}

/**
 * The whole thing: begin, hand the URL to the caller's browser opener, wait,
 * exchange, store. Returns the ref the tokens were filed under and the scopes
 * actually granted — never the tokens themselves, so a caller cannot casually
 * log them.
 *
 * `openUrl` is required and has no default: see `assertOpenable` above for why
 * this file does not open anything itself.
 */
export async function authorize({
  config = null,
  providerId,
  clientId = null,
  accountId = null,
  scopes = null,
  loginHint = '',
  openUrl,
  authorizeUrl = null,
  tokenUrl = null,
  fetchImpl = null,
  host = '127.0.0.1',
  port = 0,
  timeoutMs = RECEIVER_TIMEOUT_MS,
  now = Date.now(),
  store = true,
} = {}) {
  const p = requireProvider(providerId);
  if (typeof openUrl !== 'function') {
    throw new TypeError('oauth: authorize needs an openUrl function — this module does not open browsers itself');
  }
  const settings = config ? oauthSettings(config, p.id) : null;
  const pending = await beginAuthorization({
    config, providerId: p.id, clientId, scopes, loginHint, authorizeUrl, host, port, timeoutMs,
  });

  try {
    openUrl(assertOpenable(pending.url, { extraOrigins: authorizeUrl ? [authorizeUrl] : [] }));
  } catch (err) {
    await pending.cancel().catch(() => {});
    throw err;
  }

  const tokens = await finishAuthorization(pending, { tokenUrl, fetchImpl, now });
  const ref = tokenRef(p.id, accountId ?? settings?.accountId ?? 'default');
  if (store) await saveTokens(ref, tokens);

  return {
    ok: true,
    provider: p.id,
    ref,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    hasRefreshToken: Boolean(tokens.refreshToken),
  };
}

/**
 * A usable access token for a provider, refreshing first if the stored one is
 * spent. This is the single call a calendar source would make; everything above
 * is how it gets there.
 */
export async function accessTokenFor({
  config,
  providerId,
  accountId = null,
  ref = null,
  tokenUrl = null,
  fetchImpl = null,
  now = Date.now(),
  skewMs = 60_000,
  signal = null,
} = {}) {
  const p = requireProvider(providerId);
  const settings = oauthSettings(config, p.id);
  if (!settings.configured) {
    throw new OAuthError(
      `${p.label} is built but inert: no client id is configured. ${p.note}`,
      { code: 'not_configured', provider: p.id },
    );
  }
  const useRef = ref || tokenRef(p.id, accountId ?? settings.accountId);
  const stored = await loadTokens(useRef);
  if (!stored) {
    throw new OAuthError(`oauth: ${p.label} has not been connected on this machine`, {
      code: 'not_connected',
      provider: p.id,
    });
  }
  if (!tokensExpired(stored, { now, skewMs })) {
    return { accessToken: stored.accessToken, expiresAt: stored.expiresAt, refreshed: false, ref: useRef };
  }

  const next = await refreshTokens({
    provider: p,
    clientId: settings.clientId,
    refreshToken: stored.refreshToken,
    tokenUrl,
    fetchImpl,
    now,
    signal,
    previous: stored,
  });
  await saveTokens(useRef, next);
  return { accessToken: next.accessToken, expiresAt: next.expiresAt, refreshed: true, ref: useRef };
}
