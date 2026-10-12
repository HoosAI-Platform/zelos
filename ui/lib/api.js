/**
 * ui/lib/api.js — the only place the page talks to the server.
 *
 * Two things here are load-bearing:
 *
 *  1. The session token. core/server.mjs mints it per launch and puts it in the
 *     launch URL as `?t=…`; every /api/* request must carry it in
 *     `X-Zelos-Token` or it is a 401. It is lifted out of the URL once and
 *     stripped from the address bar (history.replaceState) so it does not sit in
 *     a screenshot, a bookmark or a Referer — then kept in sessionStorage, which
 *     dies with the tab, rather than localStorage, which does not.
 *
 *  2. SSE over fetch. `EventSource` cannot set a header, so it cannot send the
 *     token — both streams (`/api/sweep/stream`, `POST /api/ask`) are read off a
 *     fetch body reader with a hand-written SSE parser instead.
 */

const TOKEN_KEY = 'zelos.token';

function readToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode: the in-memory copy below still works for this page load */
    }
    url.searchParams.delete('t');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

let token = readToken();

export function hasToken() {
  return Boolean(token);
}

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

function headers(extra = {}) {
  return { 'X-Zelos-Token': token, ...extra };
}

/**
 * A JSON request. Errors arrive as `{error, detail}` from the server; anything
 * else (a proxy, a dead socket) becomes an ApiError that still names the path,
 * so "the server is gone" never renders as "undefined".
 */
export async function request(path, { method = 'GET', body = undefined, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? headers() : headers({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(`Zelos is not answering on ${window.location.host}. Is it still running?`, { path });
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    let message = parsed && typeof parsed.error === 'string'
      ? parsed.error
      : `${method} ${path} failed (${res.status})`;
    // A 500's `error` is the two words "internal error" — the server keeps an
    // unexpected error's text out of the response on purpose — and its
    // `detail` is the one thing it does say: where the reason was written.
    // Every view renders `err.message` and nothing reads `.detail`, so that
    // pointer never reached the screen. Joined for 5xx only: a 4xx's `error`
    // already names the caller's mistake, and its `detail` is structured
    // (the 409's running-sweep status), not prose.
    if (res.status >= 500 && parsed && typeof parsed.error === 'string' && typeof parsed.detail === 'string') {
      message = `${parsed.error} — ${parsed.detail}`;
    }
    throw new ApiError(message, { status: res.status, detail: parsed?.detail ?? null, path });
  }
  return parsed;
}

/**
 * True when a build simply does not have this route: 404 from the router, or
 * 501 from a route that exists and says it is unimplemented. Callers render an
 * honest "not in this build" state rather than an error — see
 * ui/views/ai-access.js, whose whole panel is optional in exactly that way.
 */
export function isMissingRoute(err) {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

/* --------------------------------------------------------------- endpoints */

export const api = {
  health: () => request('/api/health'),
  state: () => request('/api/state'),
  config: () => request('/api/config'),
  saveConfig: (patch) => request('/api/config', { method: 'PUT', body: patch }),
  sweep: (mode = 'auto') => request('/api/sweep', { method: 'POST', body: { mode } }),
  // `until` rides along only when the caller set one: the server treats an
  // absent field as "default to tomorrow morning", and sending null would ask
  // it to decide what null means instead.
  // `until` is three-valued on the wire and the distinction is load-bearing:
  // absent asks the server for its default (09:00 tomorrow), an explicit null
  // asks for a manual snooze with no deadline (how Undo restores a legacy
  // snooze exactly), and a string names the wake time. So the field is sent
  // whenever the caller stated one, even when what they stated is null.
  setItemState: (id, state, opts = {}) =>
    request(`/api/items/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      body: 'until' in opts && opts.until !== undefined
        ? { state, until: opts.until }
        : { state },
    }),
  capture: (text) => request('/api/capture', { method: 'POST', body: { text } }),
  setSecret: (ref, value) => request('/api/secrets', { method: 'POST', body: { ref, value } }),
  deleteSecret: (ref) => request(`/api/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  // An AI key is filed by the address it is for; the server derives where it
  // lives, and a key saved for one address is never sent to another.
  modelKeyStored: (baseUrl) => request(`/api/model/key?${new URLSearchParams({ baseUrl })}`),
  setModelKey: (baseUrl, value) => request('/api/model/key', { method: 'POST', body: { baseUrl, value } }),
  deleteModelKey: (baseUrl) => request(`/api/model/key?${new URLSearchParams({ baseUrl })}`, { method: 'DELETE' }),
  testModel: (spec) => request('/api/model/test', { method: 'POST', body: spec }),
  listModels: ({ protocol, baseUrl }) => {
    const q = new URLSearchParams();
    if (protocol) q.set('protocol', protocol);
    if (baseUrl) q.set('baseUrl', baseUrl);
    return request(`/api/model/list?${q.toString()}`);
  },
  presets: () => request('/api/model/presets'),
  probeLocal: () => request('/api/local/probe'),
  // POST, so the address rides in the body: a query string is kept by the
  // browser's history and sent as a Referer, and this call's whole input is
  // somebody's email address.
  guessMail: (email) => request('/api/mail/guess', { method: 'POST', body: { email } }),
  /* "Ask Claude to walk me through this": the message for one setup screen
     and the two links that open a chat with it typed in. POST for the same
     reason as guessMail — what rides along is what the app calls the
     provider, and the server answers with only what core/help.mjs allows in
     a message: the step, the provider's name, this computer's kind. */
  helpLinks: (args) => request('/api/help', { method: 'POST', body: args }),
  testMail: (account) => request('/api/mail/test', { method: 'POST', body: account }),
  testCalendar: (calendar) => request('/api/calendar/test', { method: 'POST', body: calendar }),

  /* "Sign in with Microsoft" and "Sign in with Google" — three calls from this
     page's point of view: start a sign-in, ask whether the person has finished
     in their browser, give up.

     There is deliberately no timing here. RFC 8628 §3.5 pins the poll interval
     and the `slow_down` back-off, core/sources/imap.mjs implements both under
     test, and the server runs that loop; a second implementation in the browser
     would be a second thing to get wrong about the one operation a vendor rate
     limit punishes. The page asks a question with no timing content and reads
     an answer.

     The device code never comes back here. Whoever holds it collects the tokens,
     so it stays in the server process — what this gets is the USER code, which
     is meant for a human to read aloud off a screen, and the address to type it
     at. Google's flow hands back an authorization URL for the browser instead;
     the code Google returns lands on the server's own loopback callback, and
     the page only ever learns that the flow is `connected`.

     `provider` defaults on the server to Microsoft, so a caller that sends what
     it always sent still gets what it always got. `clientId`, `clientSecret`
     and `email` ride along only when the caller set them — JSON.stringify
     drops an undefined field, so the wire body of an old call is unchanged.
     The one secret in here, Google's client secret, is typed by the user for
     their own Cloud project, goes once to the server on this machine, and is
     kept in the secret store under `oauth.google.clientSecret` from then on. */
  beginMailOAuth: ({ provider, keyRef, clientId, clientSecret, tenantId, email }) =>
    request('/api/mail/oauth', { method: 'POST', body: { provider, keyRef, clientId, clientSecret, tenantId, email } }),
  mailOAuthStatus: (id) => request(`/api/mail/oauth/${encodeURIComponent(id)}`),
  cancelMailOAuth: (id) =>
    request(`/api/mail/oauth/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateDraft: (id, patch, { signal } = {}) =>
    request(`/api/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: patch, signal }),
  /**
   * The index, queried. The options are optional so the one-argument call
   * `api.search(q)` still means exactly what it always did — same URL, same
   * default of twenty rows decided by the server.
   *
   * The search view needs both of them. `limit` because a page with room for a
   * list wants more than the twenty a source list wants, and `signal` because a
   * query is superseded by the next keystroke: without a way to abandon the
   * request in flight, a slow answer to `sur` can land after the answer to
   * `survey` and overwrite it with the wrong results.
   */
  search: (q, { limit = null, signal = undefined, includeHistory = false } = {}) => {
    const query = `q=${encodeURIComponent(q)}${limit === null ? '' : `&limit=${encodeURIComponent(limit)}`}${includeHistory ? '&includeHistory=1' : ''}`;
    return request(`/api/search?${query}`, { signal });
  },

  /* AI access (SPEC-v2 §1). All four answer with the same whole-state payload —
     switch, scopes, effective scopes, tokens, access log and client hints — so
     the panel applies a change by keeping the response rather than by guessing
     what the server did with it. A minted token's `value` appears in the mint
     response and nowhere else, ever. */
  ai: () => request('/api/ai'),
  saveAi: (patch) => request('/api/ai', { method: 'PUT', body: patch }),
  mintAiToken: (label) => request('/api/ai/tokens', { method: 'POST', body: { label } }),
  revokeAiToken: (id) => request(`/api/ai/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/* --------------------------------------------------------------------- SSE */

/**
 * Parse an SSE byte stream into `{event, data}`. Frames are separated by a
 * blank line; `data:` lines within one frame join with `\n`; a line starting
 * `:` is a comment (the server's heartbeat) and is dropped.
 */
function makeSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let split;
    // \r\n\r\n is legal too; normalise before splitting on the blank line.
    buffer = buffer.replace(/\r\n/g, '\n');
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') name = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length && name === 'message') continue;
      let payload = null;
      const joined = data.join('\n');
      if (joined) {
        try {
          payload = JSON.parse(joined);
        } catch {
          payload = joined;
        }
      }
      onEvent(name, payload);
    }
  };
}

/**
 * Open an SSE stream and pump it into `onEvent` until it ends or `signal`
 * aborts. Resolves when the stream closes; rejects only on a transport failure,
 * so callers can distinguish "the server hung up" from "the answer finished".
 */
export async function openStream(path, { method = 'GET', body = undefined, signal, onEvent }) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? headers({ Accept: 'text/event-stream' })
      : headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    let message = parsed && typeof parsed.error === 'string'
      ? parsed.error
      : `stream ${path} failed (${res.status})`;
    // The same join request() makes for a 5xx, for the same reason: a 500's
    // `error` is the two words "internal error", and its `detail` is the one
    // thing the server does say — where the reason was written.
    if (res.status >= 500 && parsed && typeof parsed.error === 'string' && typeof parsed.detail === 'string') {
      message = `${parsed.error} — ${parsed.detail}`;
    }
    throw new ApiError(message, {
      status: res.status,
      detail: parsed?.detail ?? null,
      path,
    });
  }
  if (!res.body) throw new ApiError(`stream ${path} returned no body`, { path });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const feed = makeSseParser(onEvent);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
