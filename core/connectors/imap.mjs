/**
 * core/connectors/imap.mjs — a mailbox, read over IMAP.
 *
 * The protocol lives in core/sources/imap.mjs (1,643 lines behind 1,507 lines of
 * tests) and none of it moved. What moved here is the three functions between
 * the protocol and the sweep — which mailboxes to read, which direction a
 * message went, and the reader the sweep's `deps.fetchMail` seam defaults to —
 * because all three are IMAP semantics that the run loop happened to be
 * holding.
 *
 * `fields` is deliberately empty. A mail account is edited by `mailForm` in
 * ui/views/settings.js, and genericising that form would cost the three-way TLS
 * selector, the SPECIAL-USE sent-folder reader and the `identity.email`
 * adoption — three behaviours with tests and a written history. A field schema
 * that cannot express them would not be a description of this connector; it
 * would be a worse editor for it.
 */

import { fetchRecent, reconnectMessage } from '../sources/imap.mjs';
import { AuthError } from './http.mjs';
import { googleSecretRefFor, oauthClient } from '../sources/oauth.mjs';
import { loadConfig } from '../config.mjs';

/**
 * Mailboxes to read for one account: the configured list plus the sent folder,
 * which is not optional — `promised` is mined from what the user themselves
 * wrote, and without the sent folder half the board cannot exist.
 */
export function mailboxesFor(account) {
  const list = Array.isArray(account.mailboxes) && account.mailboxes.length
    ? account.mailboxes.filter((m) => typeof m === 'string' && m.trim())
    : ['INBOX'];
  const out = [...new Set(list)];
  const sent = typeof account.sentMailbox === 'string' ? account.sentMailbox.trim() : '';
  if (sent && !out.includes(sent)) out.push(sent);
  return out;
}

/**
 * How this account signs in: `'password'`, `'xoauth2'`, or null for "decide from
 * what was passed".
 *
 * Read off the account rather than inferred from whether an `oauth` block
 * happens to be present, because those are different facts. A user who filled in
 * a client ID, thought better of it and switched the picker back to a password
 * has an `oauth` block and means to send a password; inferring from the block
 * would sign them in the other way and there would be nothing on screen saying
 * so. `resolveAuthMethod` in core/sources/imap.mjs makes the same distinction
 * for the same reason.
 */
export function authFor(account) {
  const stated = account?.auth;
  return typeof stated === 'string' && stated ? stated : null;
}

/**
 * What `accessTokenFor` needs, assembled from the two config keeps.
 *
 * `tokenRef` IS `account.keyRef` and is deliberately not a fourth stored field.
 * The grant lives under the account's own ref — core/sources/imap.mjs:2001 says
 * why: removing an account deletes exactly one secret, and a refresh token filed
 * anywhere else survives the user believing they disconnected the mailbox. A
 * `tokenRef` in config.json would be a second place for that to be wrong, and it
 * would be wrong silently.
 *
 * An account the sign-in buttons saved carries `clientId: ''` when the
 * server's own client ran the flow, so an empty id here means "the client
 * this install signs in with" — resolved from config at read time, exactly
 * as POST /api/mail/oauth resolved it at connect time. Without that fallback
 * the card said "Connected" and every sweep after it threw `not_configured`
 * before the stored grant was even consulted. A Google block also carries
 * `clientSecretRef`, because its refresh spends the client's secret and the
 * ref that secret was filed under is a fact about the CLIENT —
 * `googleSecretRefFor` derives the same name at connect and at refresh.
 *
 * `config` is a parameter for the tests; the sweep passes nothing and the
 * live file is read, as `runSweep` itself defaults to — and only when a
 * fallback is actually needed, so a password account or a self-registered
 * Microsoft one reads no config at all.
 *
 * Null when there is nothing to sign in with, so a caller can tell "this account
 * is not an OAuth account" from "this account is one and is misconfigured" —
 * `fetchRecent` spreads `...(oauth || {})` and `normalizeClientId` then produces
 * the sentence about a missing registration.
 */
export function oauthFor(account, config = null) {
  const block = account?.oauth;
  if (!block || typeof block !== 'object') return null;
  // Absent is Microsoft: the field postdates the first connected accounts.
  const provider = typeof block.provider === 'string' && block.provider.trim() ? block.provider.trim().toLowerCase() : 'microsoft';
  const own = typeof block.clientId === 'string' ? block.clientId.trim() : '';
  const client = provider === 'google' || (provider === 'microsoft' && !own)
    ? oauthClient(config ?? loadConfig(), provider)
    : null;
  const oauth = {
    provider,
    clientId: own || client?.clientId || '',
    tenantId: typeof block.tenantId === 'string' && block.tenantId.trim() ? block.tenantId.trim() : 'common',
    tokenRef: account?.keyRef ?? '',
  };
  if (provider === 'google') oauth.clientSecretRef = googleSecretRefFor(client, own);
  return oauth;
}

export function directionOf(message, mailbox, account, identityEmail) {
  // Compared against the trimmed name, because that is what mailboxesFor asked for.
  if (mailbox === String(account.sentMailbox ?? '').trim()) return 'out';
  const from = String(message?.from?.email ?? '').toLowerCase();
  if (from && (from === String(identityEmail).toLowerCase() || from === String(account.user).toLowerCase())) {
    return 'out';
  }
  return 'in';
}

/**
 * The default mail reader: one IMAP connection per mailbox.
 *
 * `signal` is forwarded, and that is the half of Ctrl-C that used to be missing.
 * The caller's check between mailboxes only ever caught a sweep between reads;
 * a read already on the wire ran to its own end, so the first Ctrl-C did
 * nothing a user could see and what actually ended the process was the
 * launcher's 5 s escape timer — a force-exit, not a stop. `fetchRecent` now
 * hands the signal to the client, which fails the command in flight and
 * destroys the socket, so `abort()` in the run loop is reached with the
 * connection already closed rather than still reading.
 *
 * `requireTls` is forwarded deliberately, and `?? null` rather than `|| null`,
 * because the setting is three-valued: `false` is a standing permission to talk
 * to this one host in the clear, and collapsing it into "not set" would put the
 * requirement back on a local bridge the user has already excused. An account
 * saved before the field existed has no value at all, which is what `null`
 * means — the client then decides from the host, as it always has.
 *
 * `auth` and `oauth` are forwarded for a blunter reason: without them the sweep
 * signed in with a password whatever the config said. `AUTHENTICATE XOAUTH2` and
 * the device grant were implemented and tested in core/sources/imap.mjs, and
 * `fetchRecent` grew both parameters — and this function, the only production
 * caller, passed neither. `resolveAuthMethod(null, '')` is `'password'`, so a
 * hand-edited `auth: 'xoauth2'` account validated cleanly, showed as configured,
 * and then sent a password that Microsoft has not accepted since 16 September
 * 2024. A half-wired contract that is already user-visible is worse than one
 * nobody started.
 */
export function read({ account, mailbox, pass, sinceDays, limit, onProgress, signal }) {
  return fetchRecent({
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    pass,
    auth: authFor(account),
    oauth: oauthFor(account),
    requireTls: account.requireTls ?? null,
    mailbox,
    sinceDays,
    limit,
    onProgress,
    signal,
  });
}

export default {
  type: 'imap',
  family: 'mail',
  label: 'Mail',
  option: 'IMAP mailbox',
  configKey: 'mail',
  sink: 'messages',

  /* One credential per source is the interface, and for a mailbox it is whatever
     is filed under `keyRef` — an app password on most providers, and on an
     `auth: 'xoauth2'` account the token blob core/sources/imap.mjs §6 stores
     under the same ref. `required: true` is true of both: a mailbox with nothing
     behind its ref cannot be opened either way.

     The help text no longer names Outlook among the app-password providers. It
     did, and it had been wrong for eleven months: Microsoft ended basic auth for
     personal Outlook, Hotmail, Live and MSN on 16 September 2024 and app
     passwords went with it, so that sentence sent every one of those users to
     generate a credential Microsoft refuses. */
  credential: {
    label: 'App password',
    help: 'Gmail, iCloud, Yahoo and Fastmail all want an app-specific password rather than the one you log in with. '
      + 'Personal Outlook, Hotmail, Live and MSN accounts take no password at all any more — those sign in with Microsoft instead.',
    url: '',
    required: true,
  },

  /* IMAP is not HTTP. `ctx.http` is handed over anyway — every connector gets
     the same ctx — but with nothing on the allow-list, so a future edit that
     reaches for it fails loudly instead of quietly gaining an exit. */
  origins: [],
  fields: [],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: null },

  /** NOT part of the contract; see core/connectors/calendar.mjs. */
  read,

  /**
   * One part per mailbox, which is the whole reason `parts[]` exists.
   *
   * The sweep has always pushed one `sources[]` row per MAILBOX rather than per
   * account — test/sweep.test.mjs asserts two rows for one account, INBOX and
   * Sent — so a generator, or a bare throw, would lose Sent because INBOX was
   * unreachable. A part carries its own failure and the rest of the account
   * still arrives.
   *
   * Mailboxes are read one at a time per account: they share a host, and opening
   * four IMAP connections to the same server at once is how a sweep gets
   * rate-limited or refused.
   */
  async collect(ctx) {
    const { source: account, secret: pass, deps, emit, signal, identityEmail, label } = ctx;
    const parts = [];
    for (const mailbox of mailboxesFor(account)) {
      if (signal?.aborted === true) break;
      try {
        const rows = await deps.fetchMail({
          account,
          mailbox,
          pass,
          sinceDays: account.lookbackDays ?? 14,
          limit: account.maxMessages ?? 400,
          onProgress: (p) => emit(`${label}: ${p.message}`, p.done, p.total),
          signal,
        });
        parts.push({
          label: mailbox,
          rows: (rows || []).map((row) => ({
            ...row,
            direction: directionOf(row, mailbox, account, identityEmail),
          })),
          error: null,
          note: null,
        });
      } catch (err) {
        /* A sign-in the server will no longer accept belongs to the account,
           not to this mailbox: every other mailbox would be refused the same
           way, and so would every sweep after this one. Thrown as an AuthError
           so the sweep rests the account until its sign-in changes and says
           "sign in again", instead of a part error it retried every half hour
           while recording the source as read (QA, 2026-10-10, TT-3436). */
        if (err?.reconnect === true) throw new AuthError(reconnectMessage(err));
        parts.push({ label: mailbox, rows: [], error: err, note: null });
      }
    }
    return { parts };
  },
};
