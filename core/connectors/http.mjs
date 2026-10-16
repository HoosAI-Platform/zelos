/**
 * core/connectors/http.mjs — the only way out to the network a connector gets.
 *
 * Three hand-rolled HTTP readers already exist in this repo — ics.mjs's
 * `fetchIcsText`, core/server.mjs's calendar probe, core/doctor.mjs's redirect
 * follower — and each carries its own copy of the same paragraph: that
 * `redirect: 'follow'` means twenty hops on undici, and that a measured
 * 22-origin chain contacted twenty-one hosts before anything noticed. Writing
 * that paragraph a fourth time for GitHub, a fifth for Linear and a sixth for
 * Slack is how the claim in docs/SECURITY.md — that you can watch Zelos with
 * tcpdump and see only what you configured — stops being true.
 *
 * So it is written once, here, and a connector cannot opt out quietly:
 * `ctx.http` is the object it is handed, and `test/repo.test.mjs`'s
 * "no connector reaches the network except through ctx.http" greps this
 * directory for a bare `fetch(` and fails on a hit.
 *
 * That test did not exist when this paragraph was first written, which is worth
 * recording: for several days this file documented a guard that was not there,
 * and the sentence read as enforcement while nothing enforced it. It exists
 * now, with exactly two exemptions, both named in it — this file, and
 * `ics.mjs`, whose `fetchIcsText` predates the transport and hand-rolls the
 * same one-hop redirect rule, origin-scoped credentials and timeout (its body
 * cap is this file's `readCapped`). That one is duplication rather than a hole, and it is on the list to migrate.
 *
 * Everything below is enforcement, not convenience:
 *
 *   1. ORIGIN ALLOW-LIST. A URL that is not on the connector's declared
 *      `origins`, or on the origin of a `type: 'url'` field the user filled in
 *      themselves, is refused before a socket exists. That is the whole SSRF
 *      story: a URL that arrived inside a payload — a feed's <link>, an issue
 *      body, a redirect target — is not fetchable, and it costs one array.
 *   2. ONE REDIRECT HOP, and the credential is re-sent only when the
 *      destination is the same origin. The same rule `fetchIcsText` already
 *      applies to a calendar password.
 *   3. A BYTE CAP read off the stream rather than off `content-length`, because
 *      a server that wants to hand Zelos 48 MiB will not announce it. See
 *      core/sweep.mjs's ERROR_CHARS for what a stranger's server is capable of
 *      putting in a single field.
 *   4. ONE DEADLINE covering both hops, composed with the sweep's own abort
 *      signal, so a redirect cannot buy a second full timeout.
 *   5. THE RATE NUMBERS from the manifest — the gap between two requests, and a
 *      persisted rolling budget — plus `Retry-After` when the server states one,
 *      because a declared budget is a guess and the header is the fact.
 *   6. CREDENTIAL ATTACHMENT from `credential.send`. The connector never writes
 *      an `Authorization` header and *cannot* put a token in a query string:
 *      there is no `as: 'query'`. core/log.mjs redacts `authorization` by key
 *      name and `Bearer …` by shape, but `?token=…` inside a URL is logged
 *      intact by anything that logs a URL — ours, the vendor's, and every proxy
 *      in between. Removing the option is cheaper than auditing for it.
 */

import crypto from 'node:crypto';

/** A credential that will not work again until the user does something. */
export class AuthError extends Error {
  constructor(message, { status = 401 } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/**
 * The host said no, and said when to come back.
 *
 * `retryAfterMs` is what the host is told; when the server named a moment it is
 * the server's number, and when it did not it is what is left of the declared
 * budget window. Either way it is a floor on the next attempt, never a sleep:
 * nothing in Zelos waits out a rate limit inside a sweep, because the next
 * sweep is thirty minutes away and is a better retry than three seconds.
 */
export class RateLimitError extends Error {
  constructor(message, { retryAfterMs = 0, status = 429 } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.status = status;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.round(retryAfterMs) : 0;
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** How long a 401 keeps a source resting when the credential has not changed. */
export const AUTH_BLOCK_MS = 6 * 60 * 60 * 1000;

/**
 * `Retry-After` in both forms the RFC allows.
 *
 * The delta-seconds/HTTP-date pair is the same rule core/llm.mjs:676-684
 * already implements and tests against a real 429; it is repeated rather than
 * imported because llm.mjs is the model adapter and importing it from the
 * connector transport would drag the whole completion path in behind it.
 */
export function parseRetryAfter(header, nowMs = Date.now()) {
  if (!header) return null;
  const text = String(header).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** The origin of an http(s) URL, or null for anything else. Never throws. */
export function originOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.replace(/^webcal:/i, 'https:'));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin;
}

/** sha256 of a credential, first 16 hex. Never the credential. */
export function secretHash(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * The mutable half of a source's rate state.
 *
 * The budget is PERSISTED (core/sweep.mjs writes this back into `kv` after every
 * attempt) and that is the whole point of it being an object rather than a
 * counter in a closure. An in-memory bucket refills on process start, and a
 * laptop that sleeps and wakes ten times a day would burn five hundred calls
 * against a fifty-a-day allowance without ever exceeding it as far as it knew.
 */
export function createMeter(limits = {}, state = {}, nowMs = Date.now()) {
  const budget = limits.budget || null;
  const startedAt = Number(state.windowStartedAt) || 0;
  const fresh = !budget || !startedAt || nowMs - startedAt >= budget.perMs;
  return {
    spent: fresh ? 0 : Number(state.spent) || 0,
    windowStartedAt: fresh ? nowMs : startedAt,
    lastRequestAt: 0,
    calls: 0,
  };
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('aborted'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Read a response body with a hard ceiling, off the stream.
 *
 * `res.text()` then `text.length > cap` has already bought the whole body by
 * the time it decides it was too big, and a feed with no Content-Length that
 * never ends is never too big until memory runs out. The reader stops asking for
 * chunks the moment the cap is passed. Exported for `fetchIcsText`, which keeps
 * its own request (see ics.mjs) but has no reason to keep its own body reader.
 */
export async function readCapped(res, maxBytes, describe) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`${describe} returned more than ${maxBytes} bytes — refusing to read it`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${describe} returned more than ${maxBytes} bytes — refusing to read it`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* the throw above is the real one */ }
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Build the `ctx.http` a connector is handed.
 *
 * `origins` is the union of what the connector declared and what the USER
 * configured — a feed address, a self-hosted Linear. Neither the connector nor
 * anything it read can widen it at run time.
 */
export function createHttp({
  origins = [],
  limits = {},
  credential = null,
  secret = null,
  signal = null,
  meter = null,
  graphql = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = null,
  log = null,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const allowed = new Set();
  for (const o of origins) {
    const origin = originOf(o);
    if (origin) allowed.add(origin);
  }
  const gapMs = Number(limits.minGapMs) || 0;
  const budget = limits.budget || null;
  const state = meter || createMeter(limits);

  const authHeader = () => {
    const send = credential?.send;
    if (!send || !secret) return null;
    if (send.as === 'basic') {
      const user = String(send.user ?? '');
      return ['authorization', `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`];
    }
    // 'header' is the default and the only other option. There is no 'query'.
    return [String(send.name || 'authorization').toLowerCase(), `${send.prefix ?? 'Bearer '}${secret}`];
  };

  function assertAllowed(target) {
    if (!allowed.has(target.origin)) {
      // Deliberately names the origin and not the path: the path may have come
      // from a payload and this message reaches `sources[].error`, which is
      // served by /api/state and copied into the settings export.
      throw new Error(`refusing to contact ${target.origin} — it is not one of this source's addresses`);
    }
  }

  async function spend(describe) {
    if (budget) {
      const nowMs = Date.now();
      if (nowMs - state.windowStartedAt >= budget.perMs) {
        state.spent = 0;
        state.windowStartedAt = nowMs;
      }
      if (state.spent >= budget.calls) {
        const left = state.windowStartedAt + budget.perMs - nowMs;
        throw new RateLimitError(
          `${describe}: this source's own allowance of ${budget.calls} requests is spent — waiting for the window to roll over`,
          { retryAfterMs: Math.max(0, left) },
        );
      }
      state.spent += 1;
    }
    if (gapMs > 0 && state.lastRequestAt) {
      const wait = state.lastRequestAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
    }
    state.lastRequestAt = Date.now();
    state.calls += 1;
  }

  async function send(method, rawUrl, { headers = {}, body = null, accept = null } = {}) {
    const target = new URL(String(rawUrl));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`a source may only be read over http or https (got ${target.protocol})`);
    }
    assertAllowed(target);
    await spend(target.host);

    const base = { accept: accept || 'application/json, text/plain;q=0.8, */*;q=0.5' };
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k).toLowerCase();
      // The connector does not get to write its own credential header, and it
      // does not get to redirect the request by rewriting the Host either.
      if (key === 'authorization' || key === 'host') continue;
      if (v === undefined || v === null || v === '') continue;
      base[key] = String(v);
    }
    const auth = authHeader();
    const withAuth = auth ? { ...base, [auth[0]]: auth[1] } : base;

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    // ONE deadline for both hops. Composed here rather than per-request so a
    // redirect cannot buy a second full timeout.
    const deadline = AbortSignal.any(signals);

    const once = (url, sendAuth) => doFetch(url, {
      method,
      headers: sendAuth ? withAuth : base,
      body,
      redirect: 'manual',
      signal: deadline,
    });

    let res = await once(target, true);
    let finalUrl = target;
    // Whether the answer that counts was given a credential at all.
    let sentAuth = Boolean(auth);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`${target.host} redirected without a destination`);
      const next = new URL(location, target);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`${target.host} redirected to ${next.protocol} — refusing to follow it`);
      }
      assertAllowed(next);
      await spend(next.host);
      res = await once(next, next.origin === target.origin);
      finalUrl = next;
      sentAuth = Boolean(auth) && next.origin === target.origin;
    }

    /* A refusal is only a rejected CREDENTIAL when one was sent. A feed has
       none, so a 401 or 403 there used to say "rejected the credential … check
       it in Settings" beside a form that says the source needs none, and rest
       the source for six hours until a secret that does not exist changed
       (QA, 2026-10-10, TT-3459). Sent nothing, it is an ordinary failure that
       names the address, and the next sweep tries again. */
    if ((res.status === 401 || res.status === 403) && !sentAuth) {
      throw new Error(auth
        // It has one, but a redirect took the request to another host, which
        // is never given it.
        ? `${finalUrl.host} refused to serve this address (${res.status}) after a redirect from ${target.host}, `
          + 'and Zelos does not carry your key to a host you did not choose. Check the address in Settings.'
        : `${finalUrl.host} refused to serve this address (${res.status}). This source sends no password or key, `
          + 'so check the address in Settings — it may be private, or have moved.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        `${finalUrl.host} rejected the credential (${res.status}). Check it in Settings — Zelos will not keep trying with the one it has.`,
        { status: res.status },
      );
    }
    if (res.status === 429) {
      const stated = parseRetryAfter(res.headers.get('retry-after'));
      // A stated limit is a fact and a declared budget is a guess, so the fact
      // wins: the window is closed out here so the next sweep in this process
      // does not spend the rest of an allowance the server has already refused.
      if (budget) state.spent = budget.calls;
      throw new RateLimitError(`${finalUrl.host} is rate limiting this source`, {
        retryAfterMs: stated ?? (budget ? budget.perMs : 0),
      });
    }
    if (res.status !== 304 && !res.ok) {
      throw new Error(`${finalUrl.host} returned ${res.status}`);
    }

    /* The server's own remaining-call count beats ours WHENEVER IT OFFERS ONE,
       and the absence of the header is not an offer of zero.

       `res.headers.get()` returns null for a header that is not there;
       `Number(null)` is 0; `Number.isFinite(0)` is true and `0 >= 0` is true.
       So a server that simply does not send `x-ratelimit-remaining` drove
       `state.spent` to the entire declared budget on its FIRST response, and
       every later call in the window was refused with "this source's own
       allowance is spent".

       GitHub sends the header, which is why GitHub worked and hid this. Slack,
       Linear and Todoist do not send it — so all three made exactly one request
       per window and then rested: Slack read no messages at all, and Linear and
       Todoist could never reach a second page. Measured against a loopback
       server with a declared budget of 100: one call succeeded, the second was
       refused.

       Read the header first, and only believe a number that is really there. */
    const rawRemaining = res.headers.get('x-ratelimit-remaining');
    const remaining = rawRemaining === null ? NaN : Number(rawRemaining);
    if (budget && Number.isFinite(remaining) && remaining >= 0) {
      state.spent = Math.max(state.spent, budget.calls - remaining);
    }

    const text = res.status === 304 ? '' : await readCapped(res, maxBytes, finalUrl.host);
    log?.debug('read', { url: `${finalUrl.origin}${finalUrl.pathname}`, status: res.status, bytes: text.length });
    return { status: res.status, headers: res.headers, text, url: finalUrl.href };
  }

  return {
    get: (url, opts = {}) => send('GET', url, opts),
    /**
     * GraphQL, and only GraphQL.
     *
     * A generic `request(method, …)` would make non-negotiable #2 — Zelos never
     * sends, deletes or reconfigures anything — unenforceable rather than
     * merely unwritten. A POST is here at all because Linear and friends have no
     * read API that is not one, and a manifest has to declare `graphql: true`
     * to reach it, which is a line `zelos doctor` can read out loud.
     */
    async postJson(url, body, opts = {}) {
      // `async`, so a connector that forgets to await still gets a rejection
      // rather than a synchronous throw from inside its own try-less line.
      if (!graphql) {
        throw new Error('this source did not declare `graphql: true`, so it may only read with GET');
      }
      return send('POST', url, {
        ...opts,
        body: JSON.stringify(body ?? {}),
        headers: { ...(opts.headers || {}), 'content-type': 'application/json' },
      });
    },
    /** What the host persists after the attempt. */
    meter: state,
  };
}
