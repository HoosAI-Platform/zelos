/**
 * ui/views/settings.js — the machine room.
 *
 * Every panel here writes through the server's own routes: config through
 * PUT /api/config, credentials through POST /api/secrets. Note what is missing —
 * there is no route that reads a secret back, so this file can show you that a
 * key is *stored* and never what it is. That is deliberate in core/server.mjs
 * and it is why the key fields below always start empty.
 *
 * The model panel offers a local runtime first when one is running. A model on
 * your own machine is the configuration where Zelos's central claim — nothing
 * leaves the machine — is unconditionally true, so it goes at the top, not in
 * an "advanced" drawer.
 *
 * Two registers of English live in this file, and the rule for which is which
 * is simple: anything a person sees before they have asked for more is written
 * for someone who has never heard the word "protocol". Hosts, ports, model ids,
 * file names and the reasons behind them are all still here — every one of
 * them sits under a control that literally says "Advanced" or "for experts",
 * built by `fold()` below, and nothing was deleted to make the first screen
 * plain. A 70-year-old read the previous version and stopped at "IMAP host";
 * the expert who needs that field now opens one drawer to find it.
 */

import { el, button, meander, section, copyText, replace } from '../lib/dom.js';
/* `request` rather than a named method on `api`: this panel is the only reader
   of /api/connectors, and a one-line wrapper in ui/lib/api.js would be a second
   place to look for a call that has exactly one call site. */
import { api, request } from '../lib/api.js';
import { state, saveConfig, loadConfig, setAccent, applyAccent, currentAccent, DEFAULT_ACCENT, markOnboarded, nowMark } from '../lib/store.js';
import { plural, tokenLine } from '../lib/format.js';
import { monthName } from '../lib/time.js';
import { aiAccessPanel } from './ai-access.js';
import { sourceStatusLine, connectionRecovery, setupStatus } from '../lib/source-status.js';
import { backupPanel, canUseBackups } from '../lib/backup.js';
import { updatesPanel } from '../lib/updates.js';

/**
 * The tab strip, in the order a person looks for things. The ids are routes
 * (`#/settings/model` has been a deep link since the first release and still
 * is); only the labels are words. "AI" is the model, "Email" is the mailbox,
 * and the two tabs nobody new should open say so in their own names.
 */
const PANELS = [
  { id: 'you', label: 'You' },
  { id: 'model', label: 'AI' },
  { id: 'mail', label: 'Email' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'sweep', label: 'Schedule' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'sources', label: 'Other things it can read (optional)' },
  { id: 'ai', label: 'Share with another AI (advanced)' },
  { id: 'data', label: 'Your data' },
  { id: 'about', label: 'About' },
  { id: 'appearance', label: 'Colour' },
];

/** Where Settings opens with no sub-route: the thing people come here to change. */
export const DEFAULT_PANEL = 'mail';

let uid = 0;
const nextId = (prefix) => `${prefix}-${(uid += 1)}`;

/**
 * A drawer. Collapsed by default, opened by a button that says what is inside
 * it — "Advanced", "Server settings (for experts)", "More choices" — and hidden
 * with `[hidden]`, which is what every disclosure in ui/ uses and what the one
 * load-bearing CSS rule makes stick.
 *
 * This is the only mechanism by which expert text is kept out of a
 * first-timer's way. Nothing is removed: the field, the note, the command are
 * all still built, and all still reachable by one press. A guard in
 * test/ui.test.mjs walks the rendered tree and reads only what is NOT inside
 * one of these, so the register of the open text is tested, not trusted.
 */
export function fold(label, children, { open = false } = {}) {
  const body = el('div', { class: 'unfold-body' }, children);
  body.hidden = !open;
  const toggle = el('button', {
    type: 'button',
    class: 'unfold-toggle',
    'aria-expanded': open ? 'true' : 'false',
    onclick() {
      const was = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', was ? 'false' : 'true');
      body.hidden = was;
    },
  }, [
    el('span', { class: 'unfold-caret', 'aria-hidden': 'true', text: '▸' }),
    el('span', { text: label }),
  ]);
  return el('div', { class: 'unfold' }, [toggle, body]);
}

/** The way to the one-time Microsoft setup, as a button — or its name alone when the server sent no page. */
function setupLink(href) {
  if (!/^https:\/\/\S+$/i.test(String(href || ''))) return el('span', { class: 'quiet-note', text: 'The setup page is described in docs/OAUTH.md, under Microsoft.' });
  return el('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer', text: 'Show me how ↗' });
}

/** An outbound link, https only, opened in a new tab — what desktop/guard.js hands to the system browser. */
function outLink(href, text) {
  if (!/^https:\/\/\S+$/i.test(String(href || ''))) return el('span', { text });
  return el('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer', text: `${text} ↗` });
}

/* ------------------------------------------------------------ ask Claude */

/**
 * "Stuck? Ask Claude to walk me through this · or ChatGPT · Copy this message"
 *
 * One quiet line under a setup screen. The two links open a chat in the
 * person's browser with a message already typed — which screen they are on,
 * what it shows, their provider's real steps, and how to help someone who
 * has never heard of a protocol. The server writes the message
 * (core/help.mjs) and this line only carries it: ui/ names no remote host,
 * so the addresses arrive from POST /api/help like every other outbound link
 * on these screens, and the desktop shell's guard hands a target=_blank
 * https link to the system browser exactly as it does the app-password one.
 *
 * `provider` is what the app calls it — the mail guess's label, a calendar
 * guide's id, the AI card's name — and never the address. The server reduces
 * it to a closed list before a word of it reaches the message; the address
 * is not sent at all, and test/help.test.mjs hunts every message for one.
 *
 * "Copy this message" is for the page that does not prefill: the clipboard
 * first, and when the clipboard is refused (an old browser, a page without
 * focus), the message in a box the person can select themselves — a copy
 * button that does nothing visible is the failure mode this avoids.
 *
 * A build without the route answers 404, and the line removes itself: an
 * offer that cannot be honoured is worse than no offer.
 */
export function askClaude({ step, provider = null, signIn = null, clientReady = false } = {}) {
  const claude = el('a', { class: 'link', target: '_blank', rel: 'noopener noreferrer', text: 'Ask Claude to walk me through this' });
  const chatgpt = el('a', { class: 'link', target: '_blank', rel: 'noopener noreferrer', text: 'ChatGPT' });
  const note = el('span', { class: 'quiet-note', 'aria-live': 'polite' });
  const fallback = el('textarea', {
    class: 'input',
    readonly: true,
    rows: '6',
    'aria-label': 'The message to paste into Claude or ChatGPT',
  });
  fallback.hidden = true;
  let answer = null;

  const copy = button('Copy this message', {
    class: 'link',
    onClick: async () => {
      if (!answer) return;
      let ok = false;
      try {
        ok = await copyText(answer.prompt);
      } catch {
        ok = false;
      }
      if (ok) {
        note.textContent = 'Copied. Paste it into the chat.';
        return;
      }
      fallback.value = answer.prompt;
      fallback.hidden = false;
      if (typeof fallback.select === 'function') fallback.select();
      note.textContent = 'Select the text below and copy it.';
    },
  });

  const line = el('p', { class: 'quiet-note ask-claude' }, [
    'Stuck? ', claude, ' · or ', chatgpt, ' · ', copy, ' ', note,
  ]);
  const wrap = el('div', { class: 'ask-claude-wrap', dataset: { helpStep: step } }, [line, fallback]);

  // Asked on every paint rather than cached: the answer is a few hundred
  // bytes from this machine, and a cache would be one more thing that could
  // hold a stale link after the provider changed.
  api.helpLinks({ step, provider, signIn, clientReady }).then((got) => {
    if (!/^https:\/\//.test(String(got?.claude || '')) || !/^https:\/\//.test(String(got?.chatgpt || ''))) {
      wrap.hidden = true;
      return;
    }
    answer = got;
    claude.setAttribute('href', got.claude);
    claude.setAttribute('title', got.title || '');
    chatgpt.setAttribute('href', got.chatgpt);
  }).catch(() => {
    wrap.hidden = true;
  });

  return wrap;
}

/**
 * Common IMAP hosts, as a typing aid only. core/sources/imap.mjs has the real
 * `guessImapHost`, but no route exposes it — rather than duplicate its logic
 * client-side, this is a plain datalist of hostnames and the app-password note
 * those providers require, which users otherwise read as "Zelos is broken".
 */
export const IMAP_HINTS = [
  { host: 'imap.gmail.com', label: 'Gmail', note: 'Gmail takes “Sign in with Google” below, or an app password — never your account password.' },
  { host: 'imap.mail.me.com', label: 'iCloud', note: 'iCloud needs an app-specific password.' },
  /* This preset shipped with no note at all, which read as "nothing special
     here" — the one provider where that is furthest from true. Microsoft ended
     password sign-in for personal Outlook, Hotmail, Live and MSN accounts on
     16 September 2024, app passwords included, so the shipped path for one of
     the two largest consumer mail providers was an authentication failure in the
     middle of onboarding with nothing anywhere saying why. */
  {
    host: 'outlook.office365.com',
    label: 'Outlook / Microsoft 365',
    note: 'Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live and MSN accounts on 16 September 2024, '
      + 'and app passwords went with them. Set “How Zelos signs in” to “Sign in with Microsoft” below. '
      + 'A work or school account may still take a password if your administrator has left IMAP switched on.',
  },
  { host: 'imap.mail.yahoo.com', label: 'Yahoo', note: 'Yahoo needs an app password.' },
  { host: 'imap.fastmail.com', label: 'Fastmail', note: 'Fastmail wants an app password too.' },
  { host: '127.0.0.1', label: 'Proton Bridge', note: 'Proton Bridge listens on 127.0.0.1:1143 without TLS.' },
];

/**
 * The password question, in words rather than in a boolean.
 *
 * core/config.mjs stores `requireTls` three ways on purpose: `null` means
 * "decide from the address" — required everywhere except a server on this
 * machine — while `true` and `false` are standing instructions that outlive the
 * address they were given for. A checkbox has two states and would have to
 * flatten "decide" into one of them, which is the sort of small lie that turns
 * into a password sent in the clear to a host nobody meant to excuse. So it is
 * three named choices, and the safe one is what an account gets by default.
 *
 * The labels say what the choice costs, not what protocol it selects. Nobody
 * configuring their mail should have to know what STARTTLS is to understand
 * that the third option lets a stranger on the café wifi read their password.
 */
/**
 * How a mail account signs in.
 *
 * Three choices, two stored values. `password` and `xoauth2` are what
 * core/config.mjs validates (`MAIL_AUTH_METHODS`) and core/connectors/imap.mjs
 * reads off the account. "Sign in with Google" is not a third method on the
 * wire — it is `xoauth2` with `oauth.provider: 'google'` — so its picker value
 * is translated by the form (`authMethod()`), never written to config. That is
 * why the Microsoft entry keeps the bare `xoauth2` value it always had: an
 * account written before `provider` existed has none, and is Microsoft.
 */
export const MAIL_AUTH_CHOICES = [
  { value: 'password', label: 'A password (everything except personal Microsoft mail)' },
  { value: 'google', label: 'Sign in with Google' },
  { value: 'xoauth2', label: 'Sign in with Microsoft' },
];

export const TLS_CHOICES = [
  { value: 'auto', label: 'Decide from the address (recommended)' },
  { value: 'require', label: 'Never send my password unencrypted' },
  { value: 'allow', label: 'Let this one server take it unencrypted' },
];

/** The stored value for a chosen option. Anything unrecognised is the safe one. */
export function requireTlsFor(choice) {
  if (choice === 'require') return true;
  if (choice === 'allow') return false;
  return null;
}

/** The option to show for a stored value. Only a real boolean moves it off "auto". */
export function tlsChoiceFor(requireTls) {
  if (requireTls === true) return 'require';
  if (requireTls === false) return 'allow';
  return 'auto';
}

/* ------------------------------------------------------------ form helpers */

export function field(labelText, control, { hint = null, id = null } = {}) {
  const controlId = id || nextId('f');
  control.id = controlId;
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: controlId, text: labelText }),
    control,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

export function input(props = {}) {
  return el('input', { class: 'input', type: 'text', ...props });
}

export function select(options, { value = '', ...props } = {}) {
  const node = el('select', { class: 'input', ...props },
    options.map((o) => el('option', { value: o.value, text: o.label })));
  node.value = value;
  return node;
}

export function checkbox(labelText, { checked = false, onChange, hint = null } = {}) {
  const id = nextId('c');
  const box = el('input', { class: 'checkbox', type: 'checkbox', id });
  box.checked = checked;
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return el('div', { class: 'field field-check' }, [
    el('div', { class: 'check-row' }, [box, el('label', { class: 'check-label', for: id, text: labelText })]),
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

/** A status line that can say "working", "good" or exactly what went wrong. */
export function statusLine() {
  const node = el('p', { class: 'status', role: 'status' });
  return {
    node,
    clear() { node.textContent = ''; node.className = 'status'; },
    working(text) { node.textContent = text; node.className = 'status is-working'; },
    good(text) { node.textContent = text; node.className = 'status is-good'; },
    bad(text) { node.textContent = text; node.className = 'status is-bad'; },
  };
}

function randomId(prefix) {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* --------------------------------------------------- the connector registry */

/**
 * Every connector this build has, as core/connectors/index.mjs describes it.
 *
 * This panel used to hold its own list of source kinds — three `<option>`s
 * spelled out in `calendarForm`, and nothing at all for `config.sources`. That
 * is the same defect the sweep had before the registry: a second list, in a file
 * that knows nothing about the sources it names, which nobody remembers to edit.
 * Everything below is drawn from the manifest instead, so a connector added to
 * core/connectors/ appears in the pickers, gets its own fields, and asks for its
 * own credential by name, with no edit to this file at all.
 *
 * Fetched once per page load and cached, because the answer is a property of the
 * build and cannot change while the tab is open. A failure clears the cache so
 * the next attempt is a real one rather than the same rejection replayed — a
 * server restarted while Settings was open would otherwise stay broken until the
 * page was reloaded.
 */
let connectorsPromise = null;

export function connectorManifests() {
  if (!connectorsPromise) {
    connectorsPromise = request('/api/connectors')
      .then((payload) => (Array.isArray(payload?.connectors) ? payload.connectors : []))
      .catch((err) => { connectorsPromise = null; throw err; });
  }
  return connectorsPromise;
}

/** The manifests stored under one config key, in the order the registry lists them. */
export const manifestsFor = (manifests, configKey) =>
  (Array.isArray(manifests) ? manifests : []).filter((m) => m && m.configKey === configKey);

/** One manifest by type, or null. */
export const manifestFor = (manifests, type) =>
  (Array.isArray(manifests) ? manifests : []).find((m) => m && m.type === type) || null;

/**
 * The picker for one config key: the registry's types, labelled with the
 * sentence each connector wrote for exactly this control.
 */
export const kindOptions = (manifests, configKey) =>
  manifestsFor(manifests, configKey).map((m) => ({ value: m.type, label: m.option }));

/**
 * A link, but only to somewhere a link can go.
 *
 * `credential.url` is where a user mints the token this source needs, and it
 * arrives as data over HTTP. It comes from a manifest in this build rather than
 * from a mail message, so this is not the difference between safe and unsafe —
 * but `javascript:` in an href is a script that runs on click, and a field this
 * file assigns without looking is exactly the shape of the hole ui/lib/dom.js
 * exists to close. http and https, or no link.
 */
function mintLink(href) {
  const raw = String(href ?? '').trim();
  if (!/^https?:[/][/]\S+$/i.test(raw)) return null;
  return el('a', { class: 'link', href: raw, target: '_blank', rel: 'noreferrer noopener', text: raw });
}

/**
 * The controls for one connector's `fields[]`, and the two questions a form asks
 * of them: what did the user type, and what did they leave blank that they
 * cannot.
 *
 * Six field types, because core/connectors/index.mjs's FIELD_TYPES is six and
 * says why: each one already had a control here. `int` reads back as a number
 * and everything else as a string, because that is what `settings` has to hold —
 * a connector reading `Number(settings.maxItems)` off the string "50" works
 * today and stops working the day somebody compares it to a number.
 *
 * A blank optional field is OMITTED rather than stored as '', so the connector's
 * own default applies. Storing the empty string would be a user choosing
 * "nothing" for a value they never touched.
 */
export function fieldControls(manifest, values = {}) {
  const stored = values && typeof values === 'object' ? values : {};
  const controls = [];

  for (const f of manifest?.fields ?? []) {
    const current = stored[f.name];
    const initial = current === undefined || current === null ? f.default : current;

    if (f.type === 'bool') {
      let checked = initial === true;
      controls.push({
        field: f,
        node: checkbox(f.label, { checked, onChange: (v) => { checked = v; }, hint: f.hint || null }),
        read: () => checked,
      });
      continue;
    }

    if (f.type === 'choice') {
      const options = (f.choices ?? []).map((c) => (c && typeof c === 'object'
        ? { value: String(c.value), label: String(c.label ?? c.value) }
        : { value: String(c), label: String(c) }));
      const node = select(options, { value: initial === undefined ? '' : String(initial) });
      controls.push({ field: f, node: field(f.label, node, { hint: f.hint || null }), read: () => node.value });
      continue;
    }

    const node = f.type === 'int'
      ? input({
        type: 'number',
        value: initial === undefined || initial === null ? '' : String(initial),
        ...(Number.isFinite(f.min) ? { min: String(f.min) } : {}),
        ...(Number.isFinite(f.max) ? { max: String(f.max) } : {}),
      })
      : input({
        value: initial === undefined || initial === null ? '' : String(initial),
        placeholder: f.placeholder || '',
        autocomplete: 'off',
        ...(f.type === 'url' ? { spellcheck: 'false' } : {}),
      });

    controls.push({
      field: f,
      node: field(f.label, node, { hint: f.hint || null }),
      read: () => {
        const raw = String(node.value ?? '').trim();
        if (!raw) return undefined;
        if (f.type !== 'int') return raw;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      },
    });
  }

  return {
    nodes: controls.map((c) => c.node),
    read() {
      const out = {};
      for (const c of controls) {
        const v = c.read();
        if (v !== undefined) out[c.field.name] = v;
      }
      return out;
    },
    missing() {
      return controls
        .filter((c) => c.field.required && String(c.read() ?? '').trim() === '')
        .map((c) => c.field);
    },
  };
}

/**
 * Where a secret goes, in the words of the store actually in use.
 *
 * Three hints said "your OS keychain" unconditionally — one of them under the
 * `rm -rf` block, right after "back it up by copying it" — and on the
 * encrypted-file store (any machine without a working keychain: the documented
 * headless-Linux case) that was false in the one direction that matters.
 * There, secrets.enc and .seed both sit inside the home, so a copy of the
 * folder is a copy of every credential plus the key that opens them, and a
 * user who took the panel at its word could hand that folder over as a
 * password-free snapshot. `state.health.backend.name` is the store in use and
 * aboutPanel already reads it; before health has loaded it is unknown, and
 * the keychain wording stands until it says otherwise.
 */
export function secretStoreNotes(backendName) {
  if (backendName === 'encrypted-file') {
    return {
      field: 'It goes into secrets.enc in your Zelos home, encrypted with the key in .seed beside it: never into config.json, never into a log, and there is no route that reads it back.',
      password: 'Goes into secrets.enc in your Zelos home, encrypted with the key in .seed beside it. It is never written to config.json, never passed on a command line, and never logged.',
      data: 'On this machine the stored passwords and API keys ARE in that directory: secrets.enc holds them and .seed holds the key that opens them, so a copy of the folder is a copy of the credentials plus their key. Deleting the folder deletes them too.',
    };
  }
  return {
    field: 'It goes straight to your OS keychain: never into config.json, never into a log, and there is no route that reads it back.',
    password: 'Goes straight to your OS keychain. It is never written to config.json, never passed on a command line, and never logged.',
    data: 'Stored passwords and API keys live in your OS keychain under the service com.zelos.app and are not in that directory. Remove them with your keychain tool.',
  };
}

/**
 * The same three facts, for the screens a first-timer sees. secretStoreNotes
 * above is the expert version — file names, modes, the service name — and it
 * now lives under the "for experts" drawers. These are the sentences beside a
 * password box and on the Your data tab: true on both stores, and free of any
 * word that needs decoding. The file store's data line says the one thing a
 * person backing the folder up has to know.
 */
export function plainSecretNotes(backendName) {
  const field = 'Saved on this computer only, scrambled so nobody else can read it.';
  if (backendName === 'encrypted-file') {
    return {
      field,
      data: 'Your saved passwords are in this folder too, encrypted. If you back the folder up, keep the backup somewhere private.',
      about: 'Your passwords are locked in an encrypted file on this computer.',
    };
  }
  return {
    field,
    data: 'Your saved passwords are not in this folder — they are in this computer’s own password store.',
    about: 'Your passwords are kept in this computer’s own password store.',
  };
}

/**
 * The one credential a source may have, asked for in the connector's own words.
 *
 * `credential: null` and `{required: false}` are different facts and the whole
 * difference is visible here: a connector with nothing to paste gets no field at
 * all, not a field marked optional. core/connectors/file.mjs is the case that
 * makes it matter — a calendar file on this machine has no password to be
 * missing, and offering a box for one is how a user comes to believe their .ics
 * failed because they left it empty.
 */
export function credentialControl(manifest, { keyRef = '', stored = false } = {}) {
  const credential = manifest?.credential;
  if (!credential) return null;

  const node = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: stored
      ? 'one is stored — type a new one to replace it'
      : `paste your ${credential.label.toLowerCase()}`,
  });
  const link = mintLink(credential.url);
  return {
    input: node,
    keyRef,
    node: el('div', null, [
      field(credential.label, node, {
        hint: [
          credential.help || '',
          credential.required ? '' : 'Only if this source needs one.',
          secretStoreNotes(state.health?.backend?.name).field,
        ].filter(Boolean).join(' '),
      }),
      link ? el('p', { class: 'field-hint' }, ['Mint one at ', link]) : null,
    ]),
  };
}

/* ------------------------------------------------------------------- you */

/**
 * The best guess Zelos has for "you", taken from the first mailbox that is
 * switched on.
 *
 * `identity.email` had a schema, a validator, and readers in the scorer and in
 * the prompt — and nothing a user could reach ever set it. It stayed `''`, so
 * `sameEmail(a, '')` was false for every message and the two branches at
 * core/triage.mjs:434-435 (+6 for a message addressed To: you, −2 for one you
 * were merely Cc'd on) never fired once. Reproduced at the item cap: a message
 * written straight to the user was cut from the sweep prompt entirely while
 * newer Cc-only rollups survived.
 *
 * So there are two writers, not one. The panel below is the explicit one; the
 * mail form is the other, filling this in from the account being saved when
 * nothing is set, because an install that has been running for months should
 * not have to find a new tab to stop being wrong.
 *
 * Exported so it can be tested for what it is — a pure function over the
 * config — rather than grepped for.
 */
export function defaultIdentityEmail(config) {
  const accounts = Array.isArray(config?.mail) ? config.mail : [];
  const first = accounts.find((a) => a && a.enabled !== false
    && typeof a.user === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.user.trim()));
  return first ? first.user.trim() : '';
}

function youPanel() {
  const identity = state.config?.identity || {};
  const status = statusLine();
  const stored = String(identity.email || '').trim();
  const guess = defaultIdentityEmail(state.config);

  const nameInput = input({ value: identity.name || '', placeholder: 'Nemo Hale', autocomplete: 'off' });
  const emailInput = input({
    type: 'email',
    value: stored || guess,
    placeholder: 'you@example.com',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  // Read at read time and never persisted: core/config.mjs resolves an empty
  // timezone from this machine on every load, so a laptop that moves follows.
  // Writing it back here would freeze the zone it was in the day it was typed.
  const tzInput = input({ value: identity.timezone || '', readonly: true });

  return el('div', { class: 'panel panel-you' }, [
    el('p', { class: 'panel-lede', text: 'Two facts about you. Neither leaves this computer except inside what Zelos sends to the AI you chose.' }),
    field('Your name', nameInput, {
      hint: 'Signs the replies Zelos writes. If you leave this blank, the replies Zelos writes for you will not be signed.',
    }),
    field('Your email address', emailInput, {
      hint: !stored && guess
        ? 'The address Zelos treats as yours (usually the same as your mailbox). Your first mailbox is filled in above — press Save to use it. It lets Zelos put a message written straight to you ahead of one you were only copied on.'
        : 'The address Zelos treats as yours (usually the same as your mailbox). It lets Zelos put a message written straight to you ahead of one you were only copied on, and tell your own replies from everyone else’s.',
    }),
    field('Timezone', tzInput, {
      hint: 'Read from this computer every time Zelos starts, so it follows you when you travel. Not editable here on purpose.',
    }),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          const email = emailInput.value.trim();
          // Refused here rather than as a 400 from PUT /api/config: the server's
          // rule is core/config.mjs:436 and this is the same rule, said where
          // the person typing can see which field it is about.
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            status.bad(`“${email}” is not an email address. Leave it blank if you would rather not say.`);
            return;
          }
          status.working('Saving…');
          try {
            await saveConfig({ identity: { name: nameInput.value.trim(), email } });
            status.good('Saved. Zelos uses it the next time it checks.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
  ]);
}

/* --------------------------------------------------------------- the model */

/**
 * The two providers a first-timer is offered by name, and what the guided
 * card says for each. Everything else the server's preset list carries is
 * one drawer down under "More choices", with a plain sentence apiece.
 *
 * `friendly` is the name the person has heard of — "Claude", "OpenAI" — and is
 * what the card says once the key works. `createStep` is the button on the
 * provider's own key page, spelled the way that page spells it, because "press
 * the thing that makes a key" is exactly the instruction that loses people.
 */
const GUIDED_PROVIDERS = {
  anthropic: {
    title: 'Claude, by Anthropic',
    badge: 'Recommended',
    blurb: 'Easiest to set up. Made by the company that makes Claude.',
    friendly: 'Claude',
    keyPage: 'Anthropic’s key page',
    createStep: 'Press Create Key and copy it.',
    preferModel: 'claude-sonnet-5',
  },
  openai: {
    title: 'OpenAI, who make ChatGPT',
    badge: null,
    blurb: 'The company behind ChatGPT.',
    friendly: 'OpenAI',
    keyPage: 'OpenAI’s key page',
    createStep: 'Press Create new secret key and copy it.',
    preferModel: null,
  },
};

/** One plain sentence per provider under "More choices". Anything unlisted keeps the server's own note. */
const PLAIN_PROVIDER_NOTES = {
  gemini: 'Google’s AI. The key comes from Google AI Studio.',
  groq: 'Very fast. Runs freely available models.',
  mistral: 'A French company; your mail summaries stay in Europe.',
  deepseek: 'Inexpensive.',
  xai: 'Grok, from xAI.',
  together: 'A wide choice of freely available models.',
  openrouter: 'One key that reaches most of the others.',
  fireworks: 'Fast hosted models.',
  cerebras: 'Very fast.',
};

/** Never a number. Zelos does not know what anyone pays, and a made-up figure here would be the most damaging sentence on the screen. */
export const COST_LINE = 'Pay-as-you-go. You can set a monthly spending cap on their site.';

/**
 * The model the guided card picks on the person's behalf.
 *
 * Nothing is invented: the id has to be one the preset already names in
 * `suggestedModels`, which core/llm.mjs maintains against the providers'
 * own lists. Anthropic's list leads with the largest model and the guided
 * default is the middle one — the one that reads a day of mail without
 * costing like the flagship — so the preference is stated here, and falls
 * back to the list's first entry when the preferred id is not on it.
 */
export function pickDefaultModel(preset, preferred = GUIDED_PROVIDERS[preset?.id]?.preferModel) {
  const list = Array.isArray(preset?.suggestedModels) ? preset.suggestedModels.filter(Boolean) : [];
  if (preferred && list.includes(preferred)) return preferred;
  return list[0] || '';
}

/**
 * The model panel, shared with onboarding. `onDone` fires after a save that
 * leaves the model usable, which is what lets the onboarding flow advance.
 *
 * Three layers, top to bottom, and the person reads only as far as they need:
 *
 *   1. A runtime already running on this computer (when the probe found one,
 *      and only then — nobody is shown a sentence about four ports), then the
 *      two providers most people have heard of, as cards.
 *   2. The guided card for whichever was chosen: open the key page, create a
 *      key, paste it, press "Check it works". That one button stores the key,
 *      tests the connection, picks the model and saves — the same four calls
 *      the expert form makes from four buttons, in the only sensible order.
 *   3. "More choices" and "Advanced", both collapsed. The expert form with
 *      base URL, model id and "List available models" is the Advanced drawer,
 *      unchanged in what it does.
 */
export function modelPanel({ compact = false, onDone = null } = {}) {
  const cfg = state.config?.model || {};
  const draft = {
    protocol: cfg.protocol || 'anthropic',
    label: cfg.label || '',
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    keyRef: cfg.keyRef || 'model.default',
    // The guided card to show, or null for the expert form alone. Set by
    // choose(); restored from the saved config once the presets arrive.
    guide: null,
    suggested: [],
  };

  const status = statusLine();
  const localWrap = el('div', { class: 'runtime-list' });
  const choiceWrap = el('div', { class: 'preset-grid' }, el('p', { class: 'quiet-note', text: 'Loading the list of AI services…' }));
  const moreWrap = el('div', { class: 'preset-grid' });
  const guidedWrap = el('div', { class: 'chosen' });
  guidedWrap.hidden = true;
  const formWrap = el('div', { class: 'chosen' });
  const probeNote = el('p', { class: 'quiet-note' });
  // The "Stuck?" line, redrawn with the card's name once one is chosen so the
  // message Claude gets is about Anthropic's key page and not both.
  const helpSlot = el('div');

  // Refs this panel has stored itself since it was drawn. `state.secretRefs`
  // is refreshed by a config save, not by POST /api/secrets, so a key stored
  // on the way into "Test the connection" would otherwise still read as
  // missing when Save is pressed a moment later — and be refused.
  const storedHere = new Set();
  const keyStored = () => state.secretRefs.includes(draft.keyRef) || storedHere.has(draft.keyRef);
  const isLocal = () => /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:|\/|$)/i.test(draft.baseUrl || '');
  const friendly = () => draft.guide?.friendly || draft.label || 'this service';

  function drawForm() {
    const modelInput = input({ value: draft.model, placeholder: 'model id, e.g. llama3.1:8b', list: 'zelos-models' });
    modelInput.addEventListener('input', () => { draft.model = modelInput.value.trim(); });

    const baseInput = input({ value: draft.baseUrl, placeholder: 'https://…' });
    baseInput.addEventListener('input', () => { draft.baseUrl = baseInput.value.trim(); });

    // One key box. It sits in the guided card when there is one and in the
    // Advanced form otherwise; the helpers below read it wherever it is.
    const keyInput = el('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: keyStored() ? 'a key is saved — paste a new one to replace it' : 'paste the key here',
    });

    const datalist = el('datalist', { id: 'zelos-models' });
    const suggestions = el('div', { class: 'suggestions' });

    /**
     * Put whatever is in the key field into the secret store, and empty the
     * field. There is no route that carries a key alongside a test or a list
     * call — secrets travel only through POST /api/secrets, by design — so
     * the field is stored first and the call then names the ref. Before this
     * was shared, only Save did it: paste a key, press Test, and the test went
     * out with the ref of a key that was not stored yet, and came back
     * "No API key configured" about the key sitting in the field.
     */
    async function storeTypedKey() {
      const key = keyInput.value.trim();
      if (!key) return;
      await api.setSecret(draft.keyRef, key);
      storedHere.add(draft.keyRef);
      keyInput.value = '';
    }

    // A hosted service will not answer without a key, and the server says so
    // only after the call; said here, before it, about the field it is about
    // — and in the name of the service, not of the address behind it.
    const needsKey = () => `Paste the key first — ${friendly()} will not answer without one.`;

    async function loadModels() {
      try {
        await storeTypedKey();
      } catch (err) {
        suggestions.replaceChildren(el('span', { class: 'quiet-note', text: `Could not store the key: ${err.message}` }));
        return;
      }
      if (!isLocal() && !keyStored()) {
        suggestions.replaceChildren(el('span', { class: 'quiet-note', text: needsKey() }));
        return;
      }
      suggestions.replaceChildren(el('span', { class: 'quiet-note', text: 'Asking the endpoint what it has…' }));
      try {
        const models = await api.listModels({
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          keyRef: draft.keyRef,
        });
        datalist.replaceChildren(...models.map((m) => el('option', { value: m.id })));
        suggestions.replaceChildren(
          el('span', { class: 'quiet-note', text: `${plural(models.length, 'model')} available. ` }),
          ...models.slice(0, 8).map((m) => button(m.id, {
            class: 'pill',
            onClick: () => { draft.model = m.id; modelInput.value = m.id; },
          })),
        );
      } catch (err) {
        suggestions.replaceChildren(el('span', { class: 'quiet-note', text: `Could not list models: ${err.message}` }));
      }
    }

    async function save() {
      if (!draft.baseUrl || !draft.model) {
        status.bad('An address and a model id are both required — both are under Advanced.');
        return false;
      }
      // Refused rather than saved: a hosted model with no key is a model every
      // sweep fails on, and this save used to go through silently — and, in
      // onboarding, advance to the next step on the strength of it.
      if (!isLocal() && !keyStored() && !keyInput.value.trim()) {
        status.bad(`${friendly()} needs a key. Paste one above, or pick an AI program on this computer.`);
        return false;
      }
      status.working('Saving…');
      try {
        await storeTypedKey();
        await saveConfig({
          model: {
            protocol: draft.protocol,
            label: draft.label || draft.model,
            baseUrl: draft.baseUrl,
            model: draft.model,
            keyRef: draft.keyRef,
          },
        });
        status.good('Saved.');
        return true;
      } catch (err) {
        status.bad(err.message);
        return false;
      }
    }

    async function test() {
      try {
        await storeTypedKey();
      } catch (err) {
        status.bad(`Could not store the key: ${err.message}`);
        return false;
      }
      if (!isLocal() && !keyStored()) {
        status.bad(needsKey());
        return false;
      }
      status.working(`Checking that ${friendly()} answers…`);
      try {
        const result = await api.testModel({
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          model: draft.model,
          keyRef: draft.keyRef,
        });
        if (result.ok) status.good(`Answered in ${result.ms}ms: “${result.sample}”`);
        else status.bad(result.error || `${friendly()} refused the call.`);
        return result.ok;
      } catch (err) {
        status.bad(err.message);
        return false;
      }
    }

    /**
     * The guided card's one button. Store, test, save — test() and save()
     * above, in that order, so the model-panel rules (a key is stored before
     * the call that needs it; a hosted service with no key is refused before
     * anything is written) hold on this path exactly as they do on the expert
     * one. The model was picked when the card was chosen, so there is nothing
     * for the person to type but the key.
     */
    async function checkItWorks() {
      if (!draft.model) {
        status.bad('Zelos could not pick a model for this service — choose one under Advanced.');
        return false;
      }
      const answered = await test();
      if (!answered) return false;
      const saved = await save();
      if (!saved) return false;
      status.good(`Working. Zelos will use ${friendly()}.`);
      onDone?.();
      return true;
    }

    const keyHint = keyStored()
      ? 'A key is saved. For safety it is never shown again.'
      : plainSecretNotes(state.health?.backend?.name).field;
    const keyField = field(draft.guide ? 'Your key' : 'API key', keyInput, {
      hint: draft.guide ? keyHint : (keyStored()
        ? 'A key is already stored for this slot. Zelos cannot show it back to you — there is no route that reads a secret.'
        : secretStoreNotes(state.health?.backend?.name).field),
    });

    // The guided card: the steps, the key box, one button.
    const guide = draft.guide;
    guidedWrap.hidden = !guide;
    if (guide) {
      const steps = guide.local
        ? [
          el('p', { text: `Zelos found ${guide.friendly} running on this computer. Nothing you read will leave this computer.` }),
          el('p', { text: draft.model
            ? `It will use ${draft.model}.`
            : `${guide.friendly} is running but has nothing loaded yet. Load something in ${guide.friendly}, then press the button.` }),
        ]
        : [
          el('p', {}, [
            '1. Open ',
            outLink(guide.keyUrl, guide.keyPage),
            ' — they may ask you to sign in or make an account.',
          ]),
          el('p', { text: `2. ${guide.createStep}` }),
          el('p', { text: '3. Paste it here.' }),
        ];
      replace(guidedWrap, [
        el('div', { class: 'chosen-head' }, [
          el('span', { class: 'chosen-label', text: guide.title }),
          guide.local ? el('span', { class: 'badge-local', text: 'on this computer' }) : null,
        ]),
        el('div', { class: 'stack' }, steps),
        guide.local ? null : keyField,
        el('div', { class: 'row-inline' }, [
          button('Check it works', { class: 'btn solid', onClick: checkItWorks }),
        ]),
        status.node,
        guide.local ? null : el('p', { class: 'quiet-note', text: COST_LINE }),
      ]);
    }

    // Through dom.js's replace(), which skips a null child: the status line
    // and the key field each have one home, and a native replaceChildren
    // handed a null throws in every browser.
    replace(formWrap, [
      el('div', { class: 'chosen-head' }, [
        el('span', { class: 'chosen-label', text: draft.label || 'Custom endpoint' }),
        el('span', { class: 'mono chosen-proto', text: draft.protocol }),
        isLocal() ? el('span', { class: 'badge-local', text: 'on this machine' }) : null,
      ]),
      field('Base URL', baseInput, { hint: 'Where the requests go. Nothing else is contacted.' }),
      field('Model', modelInput, {
        hint: isLocal() ? 'Whatever your runtime has pulled.' : 'The provider’s model id, exactly as they spell it.',
      }),
      datalist,
      el('div', { class: 'row-inline' }, [
        button('List available models', { class: 'btn quiet', onClick: loadModels }),
        suggestions,
      ]),
      guide
        ? el('p', { class: 'field-hint', text: 'The key box is in the card above.' })
        : isLocal() && !keyStored()
          ? el('p', { class: 'field-hint', text: 'Local runtimes usually need no key, and Zelos will not invent one.' })
          : keyField,
      el('div', { class: 'row-inline' }, [
        button('Save', {
          class: 'btn solid',
          onClick: async () => {
            const ok = await save();
            if (ok && onDone) onDone();
          },
        }),
        button('Test the connection', { class: 'btn quiet', onClick: test }),
        keyStored()
          ? button('Forget the stored key', {
            class: 'btn quiet',
            onClick: async () => {
              try {
                await api.deleteSecret(draft.keyRef);
                storedHere.delete(draft.keyRef);
                await saveConfig({});
                status.good('Key deleted.');
                drawForm();
              } catch (err) {
                status.bad(err.message);
              }
            },
          })
          : null,
      ]),
      // The status line has one home. It sits in the guided card when there
      // is one, so the expert form borrows it only when it is the whole panel.
      guide ? null : status.node,
    ]);

    replace(helpSlot, [askClaude({
      step: 'ai',
      provider: guide ? (guide.local ? 'local' : guide.friendly) : null,
    })]);
  }

  function choose(next, { scroll = true } = {}) {
    Object.assign(draft, next);
    drawForm();
    if (scroll) (draft.guide ? guidedWrap : formWrap).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** The guided card for a hosted preset, or for a runtime the probe found. */
  const guideFor = (preset) => ({
    ...GUIDED_PROVIDERS[preset.id],
    keyUrl: preset.keyUrl || '',
    local: false,
  });
  const guideForRuntime = (rt) => ({
    title: `${rt.label}, on this computer`,
    friendly: rt.label,
    local: true,
  });

  api.probeLocal().then((found) => {
    if (!found?.length) {
      // Said under Advanced, and only there. A first-timer is not told about
      // four ports that did not answer; an expert who started a runtime and
      // wonders why it is not listed finds the list of what was tried.
      probeNote.textContent = 'No AI program answered on this computer. Zelos checks the usual four — Ollama on 11434, LM Studio on 1234, llama.cpp on 8080, vLLM on 8000 — and looks nowhere else; it will not go hunting on the network. Start one and reopen this panel.';
      return;
    }
    localWrap.replaceChildren(...found.map((rt) => el('button', {
      type: 'button',
      class: 'preset',
      onclick: () => choose({
        protocol: 'openai',
        label: rt.label,
        baseUrl: rt.baseUrl,
        model: rt.models?.[0]?.id || '',
        guide: guideForRuntime(rt),
      }),
    }, [
      el('span', { class: 'preset-label', text: `An AI program on this computer — ${rt.label}` }),
      el('span', { class: 'preset-note', text: 'Most private. The AI processes what Zelos reads on this computer.' }),
    ])));
  }).catch((err) => {
    probeNote.textContent = `Could not look for an AI program on this computer: ${err.message}`;
  });

  api.presets().then((presets) => {
    const hosted = (presets || []).filter((p) => !p.local);
    const guided = hosted.filter((p) => GUIDED_PROVIDERS[p.id]);
    const rest = hosted.filter((p) => !GUIDED_PROVIDERS[p.id]);

    choiceWrap.replaceChildren(...guided.map((p) => {
      const g = GUIDED_PROVIDERS[p.id];
      return el('button', {
        type: 'button',
        class: 'preset',
        onclick: () => choose({
          protocol: p.protocol,
          label: p.label,
          baseUrl: p.baseUrl,
          model: pickDefaultModel(p),
          guide: guideFor(p),
        }),
      }, [
        el('span', { class: 'preset-label', text: g.badge ? `${g.title} — ${g.badge}` : g.title }),
        el('span', { class: 'preset-note', text: g.blurb }),
      ]);
    }));

    moreWrap.replaceChildren(...rest.map((p) => el('button', {
      type: 'button',
      class: 'preset',
      onclick: () => choose({
        protocol: p.protocol,
        label: p.label,
        baseUrl: p.baseUrl,
        model: pickDefaultModel(p),
        guide: null,
      }),
    }, [
      el('span', { class: 'preset-label', text: p.label }),
      el('span', { class: 'preset-note', text: PLAIN_PROVIDER_NOTES[p.id] || p.note || '' }),
    ])));

    // A saved provider that has a guided card gets it back on open, model and
    // all, so Settings › AI says "Claude" to someone who chose Claude rather
    // than opening on a blank expert form. A fresh home is this case too:
    // core/config.mjs's DEFAULTS pre-select the Anthropic preset with an
    // empty model id, and a card restored with that blank told the first
    // person to press "Check it works" that it could not pick a model — found
    // by driving the app, not by the tests, which always clicked the card.
    const current = guided.find((p) => p.baseUrl && p.baseUrl === draft.baseUrl);
    if (current) choose({ guide: guideFor(current), model: draft.model || pickDefaultModel(current) }, { scroll: false });
  }).catch(() => {
    choiceWrap.replaceChildren(el('p', { class: 'quiet-note', text: 'Could not load the list of AI services.' }));
  });

  drawForm();

  return el('div', { class: 'panel panel-model' }, [
    el('p', { class: 'panel-lede', text: compact
      ? 'Zelos sends your mail summaries to the AI you pick here, and to nothing else.'
      : 'Pick the AI that reads your mail. Your mail summaries go to the AI you choose.' }),
    localWrap,
    choiceWrap,
    guidedWrap,
    fold('More choices', moreWrap),
    fold('Advanced', [probeNote, formWrap]),
    helpSlot,
  ]);
}

/* ---------------------------------------------------------------- mail */

/**
 * The name this server gives its sent folder, from the SPECIAL-USE flag the
 * IMAP client already reads.
 *
 * `core/sweep.mjs`'s `mailboxesFor()` appends `account.sentMailbox` to every
 * fetch and the stored default is the bare word "Sent" — right for Fastmail and
 * a plain Dovecot, wrong for Gmail (`[Gmail]/Sent Mail`), Microsoft 365
 * (`Sent Items`) and iCloud (`Sent Messages`), which are three of the eight
 * providers this app hardcodes and the three largest. Until this field existed
 * the value had no writer anywhere in `ui/`, so those accounts reported
 * `Mailbox doesn't exist: Sent` on every sweep, forever, while the run itself
 * stayed `ok: true` and the board simply never learned what the user had
 * already answered.
 *
 * `listMailboxes()` has computed `specialUse: 'sent'` from the server's own
 * `\Sent` flag since the client was written (core/sources/imap.mjs:1176), and
 * `testConnection` has returned it, and nothing outside a test had ever read
 * it. This is that reader: press "Test the connection" and the right name
 * arrives without anyone having to know their provider's spelling.
 *
 * What is typed wins over the flag — but only if the server actually has it.
 * A name that is not on the server is not a preference, it is a typo, and
 * silently keeping it is how this defect looked like nothing at all.
 */
export function sentMailboxFromTest(mailboxes, current = '') {
  const list = Array.isArray(mailboxes) ? mailboxes : [];
  const names = new Set(list.map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean));
  const flagged = list.find((m) => m && typeof m === 'object' && m.specialUse === 'sent')?.name || '';
  const chosen = String(current ?? '').trim();
  if (chosen && names.has(chosen)) return chosen;
  return flagged || chosen;
}

// Said before the save, about the field it is about. Without this the
// account went in with no secret and said "Saved." — and every sweep after
// it reported "No password stored", which is true, after the fact, and the
// one moment nobody was looking at Settings. The operator's own mailbox
// shipped this way on the first evening. Module-level because both mail
// forms refuse with it, and a refusal worded two ways is two rules.
const NEEDS_PASSWORD = 'This account needs a password — paste it above. Gmail and Yahoo want an app password, not the account one.';

/**
 * The simple card's version of the same refusal, said about the box it has
 * just opened rather than one "above" that may have been hidden. Google's
 * sentence names the thing Google actually hands out — sixteen letters — and
 * every provider's names the button that makes one.
 */
export function needsPassword(guess) {
  const google = guess?.signIn === 'google';
  return google
    ? 'Paste the 16-letter app password from Google here. Don’t have one yet? Press Get an app password.'
    : 'Paste the app password here. Don’t have one yet? Press Get an app password.';
}

/**
 * What the card says about a provider, in plain words.
 *
 * The server's `guess.note` is written for the doctor and the expert form: it
 * says "over IMAP", names `myaccount.google.com → Security → App passwords`,
 * and for Microsoft says "register a free app". Every one of those sentences
 * is still shown — under "Server settings (for experts)" — and these are what
 * a person reads first. Keyed by the label the server gives the provider,
 * which is the one string the two sides already share.
 */
export function plainProviderNote(guess) {
  if (!guess?.host) return guess?.note || '';
  if (guess.auth === 'bridge') {
    return 'Proton Mail works through Proton Bridge, a program from Proton that runs on this computer. Open Bridge, copy the settings it shows you, and enter them under Server settings.';
  }
  if (guess.auth === 'xoauth2') {
    return guess.clientReady
      ? 'Press Sign in with Microsoft. Zelos shows you a short code; type it at microsoft.com/devicelogin and sign in there as usual.'
      : 'Hotmail and Outlook.com need a one-time setup at Microsoft’s website first — about ten minutes, and no new account.';
  }
  if (guess.signIn === 'google') {
    return guess.clientReady
      ? 'Press Sign in with Google and finish in the tab that opens. Or use an app password instead — the link below explains.'
      : 'Google does not let other programs use your normal password. Instead it makes a special 16-letter password just for Zelos. You need Google’s text-message sign-in (2-Step Verification) switched on first — the page below walks you through both.';
  }
  if (!guess.known) {
    return `We guessed ${guess.host} — Connect will tell you if that is right. Many providers want a special app password rather than your normal one.`;
  }
  const name = String(guess.label || 'This provider').replace(/ Mail$/, '');
  return `${name} needs a special password made just for Zelos (it calls it an app password). The button below opens the page where you make one.`;
}

/** Under the "Get an app password" button: what the person will see there, and that they have to come back. */
export function appPasswordSteps(guess) {
  if (guess?.signIn === 'google') {
    return 'Google opens in a new tab and may ask you to sign in. Type a name like ‘Zelos’, press Create, copy the 16 letters, then come back here and paste them.';
  }
  const name = String(guess?.label || 'Your provider').replace(/ Mail$/, '');
  return `${name} opens in a new tab and may ask you to sign in. Make a new app password, name it something like ‘Zelos’, copy it, then come back here and paste it.`;
}

/**
 * The pages the guided cards send a person to — Google Calendar's settings,
 * Apple's app-specific passwords and iCloud's CalDAV host, Outlook's
 * calendar, the Microsoft one-time setup — as GET /api/guides hands them
 * over. ui/ names no remote host itself (three suites assert it, so the page
 * works offline and shows only addresses this server gave it), which is why
 * these, like the presets' key pages and the mail guess's app-password pages,
 * arrive as data. Fetched once per page load; a build without the route
 * answers 404, and the cards then say the page's name without linking it.
 */
let guidesPromise = null;

export function guideLinks() {
  if (!guidesPromise) {
    guidesPromise = request('/api/guides')
      .then((payload) => (payload && typeof payload === 'object' ? payload : {}))
      .catch(() => ({}));
  }
  return guidesPromise;
}

/**
 * Where a sign-in flow stands, read off whatever the server called it.
 *
 * The Microsoft device flow has always answered `state`; the route that grew
 * Google answers `status` for both providers. Reading either here means the
 * two blocks below do not care which build of the server they are talking
 * to, and a rename on the wire cannot leave a panel spinning on a flow that
 * finished.
 */
const flowStatus = (flow) => flow?.status ?? flow?.state;

/**
 * "Sign in with Microsoft"
 *
 * Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live
 * and MSN on 16 September 2024, and app passwords went with them — so the
 * preset in IMAP_HINTS above was, until this existed, an instruction to do
 * something impossible, offered during onboarding.
 *
 * The client ID and tenant are the USER'S until Zelos ships its own
 * registration. `clientReady` is the server's word (POST /api/mail/guess)
 * that a client exists — Zelos's own, or one pasted into config — and when it
 * does, the registration form is hidden rather than removed: the fields are
 * still the way a person with their own tenant overrides the shipped one, and
 * a block with one shape is one block to test. Until then, what a person
 * registers in their own Entra tenant needs no approval from anybody, which
 * is the whole reason this flow was reachable at all.
 *
 * No timing lives here. The server runs the RFC 8628 poll loop with its
 * back-off; this asks "has anything changed" on a fixed two seconds, which is
 * a UI refresh rate and not a protocol constant. If those two ever have to
 * agree, the wrong one is this one.
 *
 * Built once and handed to whichever form is showing it — the full mail form
 * and the simple one both — so the device flow exists in one place. `user`
 * is read when the button is pressed, not captured, because the mailbox being
 * signed in to is whatever the form says at that moment. `onStart` receives
 * the client id and tenant the person typed, which is what the account has to
 * be saved with; `onConnected` fires when Microsoft has handed over a grant.
 */
function microsoftSignIn({ keyRef, user, clientId = '', tenantId = 'common', clientReady = false, setupUrl = '', linkShownAbove = false, onStart = null, onConnected = null }) {
  const clientIdInput = input({ value: clientId, placeholder: '00000000-0000-0000-0000-000000000000', autocomplete: 'off' });
  const tenantInput = input({ value: tenantId || 'common', placeholder: 'common', autocomplete: 'off' });
  // `provider` travels with the account from here on, so a sweep can tell a
  // Microsoft grant from a Google one; an account saved before it existed has
  // none, and the sweep reads that as Microsoft. With the id field empty the
  // server signs in with its own client and answers with the id it used —
  // `grantedClientId` — so the saved account names the client its grant was
  // actually minted for, instead of an empty string.
  let grantedClientId = '';
  const oauth = () => ({ provider: 'microsoft', clientId: clientIdInput.value.trim() || grantedClientId, tenantId: tenantInput.value.trim() || 'common' });

  const signInStatus = statusLine();
  const codeBox = el('div', { class: 'device-code' });
  let poll = null;
  let flowId = null;

  const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

  /* The panel is rebuilt whenever the account form is, and an interval that
     outlives its node keeps calling a server about a sign-in nobody is watching
     — and keeps a finished flow's verdict from ever being read. */
  const landed = (flow) => {
    stopPolling();
    flowId = null;
    codeBox.replaceChildren();
    if (flowStatus(flow) === 'connected') {
      grantedClientId = flow.clientId || grantedClientId;
      signInStatus.good('Signed in. Zelos stays signed in on its own from here.');
      onConnected?.();
    } else if (flowStatus(flow) === 'cancelled') {
      signInStatus.bad('Sign-in cancelled.');
    } else {
      signInStatus.bad(flow.error || flow.message || 'Microsoft refused the sign-in.');
    }
  };

  const showCode = (flow) => {
    codeBox.replaceChildren(
      el('p', { class: 'quiet-note', text: 'Open the address below and type this code. Leave this panel open.' }),
      el('p', { class: 'device-code-value', text: flow.userCode || '' }),
      el('a', {
        href: /^https:\/\//.test(flow.verificationUri || '') ? flow.verificationUri : '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: flow.verificationUri || '',
      }),
      button('Give up', {
        class: 'btn quiet',
        onClick: async () => {
          const id = flowId;
          stopPolling();
          flowId = null;
          codeBox.replaceChildren();
          signInStatus.working('Sign-in cancelled.');
          if (id) await api.cancelMailOAuth(id).catch(() => {});
        },
      }),
    );
  };

  async function start() {
    if (!user()) { signInStatus.bad('Fill in the username first — it is the mailbox being signed in to.'); return; }
    // With a shipped client the id is optional: an empty one tells the server
    // to use its own. Without one there is no flow to start — and the answer
    // to a person who pressed the big button is the page that walks them
    // through the one-time setup, never a sentence about an ID they have
    // never heard of. The fields for that ID are one drawer down.
    if (!clientReady && !clientIdInput.value.trim()) {
      signInStatus.bad('One more step first: Zelos needs a one-time setup at Microsoft’s website (about ten minutes). The page below shows every click; the ID it gives you goes under “For work accounts (advanced)”.');
      // The simple card already shows the link above the button; the full
      // form does not, so the block carries it there.
      if (!linkShownAbove) codeBox.replaceChildren(el('div', { class: 'row-inline' }, [setupLink(setupUrl)]));
      return;
    }
    const chosen = oauth();
    onStart?.(chosen);
    stopPolling();
    signInStatus.working('Asking Microsoft for a code…');
    try {
      const flow = await api.beginMailOAuth({
        provider: 'microsoft',
        keyRef,
        ...(chosen.clientId ? { clientId: chosen.clientId } : {}),
        tenantId: chosen.tenantId,
      });
      flowId = flow.id;
      if (flowStatus(flow) !== 'pending') { landed(flow); return; }
      signInStatus.working('Waiting for you to finish in the browser…');
      showCode(flow);
      poll = setInterval(async () => {
        try {
          const now = await api.mailOAuthStatus(flowId);
          if (flowStatus(now) === 'pending') { showCode(now); return; }
          landed(now);
        } catch (err) {
          // A 404 means the server restarted or the flow expired; either way
          // there is nothing left to wait for, and silently spinning forever is
          // the one outcome worse than saying so.
          stopPolling();
          codeBox.replaceChildren();
          signInStatus.bad(err.message || 'The sign-in is no longer waiting.');
        }
      }, 2000);
    } catch (err) {
      signInStatus.bad(err.message || 'Could not start the sign-in.');
    }
  }

  // Hidden, not dropped, when the server has a client of its own: the same
  // two fields are how a tenant of one's own overrides it, and `[hidden]` is
  // what every collapsed thing in ui/ uses, so the CSS rule that makes it
  // stick covers this one too.
  const registration = el('div', { class: 'stack' }, [
    field('Application (client) ID', clientIdInput, {
      hint: 'Only for a work or school account whose IT department gave you an ID, or after the one-time setup at Microsoft’s website (“Show me how” above). Register an app there, switch on “Allow public client flows”, and paste its Application (client) ID here.',
    }),
    field('Directory (tenant) ID', tenantInput, {
      hint: 'Leave it as “common” for a personal Outlook, Hotmail, Live or MSN account. A work or school mailbox needs the ID its administrator gives you.',
    }),
  ]);
  // Folded, not merely hidden: a field a person is told to leave alone should
  // not be on the screen, and a work account's administrator knows to open
  // the drawer that names them.
  const workAccounts = fold('For work accounts (advanced)', registration);
  workAccounts.hidden = clientReady;

  const node = el('div', { class: 'stack' }, [
    el('div', { class: 'row-inline' }, [
      button('Sign in with Microsoft', { class: 'btn solid', onClick: start }),
    ]),
    signInStatus.node,
    codeBox,
    workAccounts,
  ]);

  return {
    node,
    oauth,
    /** Stop asking the server about a sign-in nobody is looking at any more. */
    stop() { stopPolling(); codeBox.replaceChildren(); },
  };
}

/**
 * "Sign in with Google"
 *
 * The same shape as microsoftSignIn — `{ node, oauth(), stop() }` — built once
 * and shown by either mail form, so the Google flow exists in one place. The
 * grant is different underneath: Google has no device code, so the server
 * mints an authorization URL (PKCE, loopback redirect) and this opens it in a
 * NEW tab. An `<a target="_blank">` rather than window.open, for two reasons.
 * The desktop shell's guard (desktop/guard.js) routes every new-window request
 * for an https address — anchor or window.open alike — to the system browser
 * and denies it in the board's own window, so either would work there; but the
 * anchor is also a real link a person can press if the automatic open was
 * swallowed by a popup blocker, and it is the convention the app-password
 * button in the simple form already uses. The code Google sends back lands on
 * the server's own /oauth/callback; nothing about it ever reaches this page,
 * which only asks "is it done yet" and is told the address it signed in as.
 *
 * `clientReady` is the server's word (POST /api/mail/guess) that a Google
 * client exists: Zelos's own once it ships one, or one pasted into config.
 * Without it the block says so in a sentence and offers, collapsed, the two
 * fields of a Google Cloud client of the person's own. The secret among them
 * is typed into a password field, read once when the button is pressed, sent
 * once to the server on this machine — which files it in the secret store —
 * and cleared from the field before the request is even answered; it is never
 * in `oauth()` and never in the saved account.
 *
 * `email` is read when the button is pressed, like microsoftSignIn's `user`.
 * `signedInAs` is the address an already-connected account is signed in as,
 * so editing one reads "Signed in · you@…" with a way to sign in again.
 */
function googleSignIn({ keyRef, email, clientReady = false, clientId = '', signedInAs = '', onStart = null, onConnected = null }) {
  const clientIdInput = input({ value: clientId, placeholder: '…apps.googleusercontent.com', autocomplete: 'off' });
  const secretInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'client secret' });
  // With the id field empty the server signs in with its own client and
  // answers with the id it used — `grantedClientId` — so the saved account
  // names the client its grant was actually minted for, instead of an empty
  // string no refresh can spend.
  let grantedClientId = '';
  const oauth = () => ({ provider: 'google', clientId: clientIdInput.value.trim() || grantedClientId });
  const address = () => (typeof email === 'function' ? email() : String(email || '')).trim();

  const signInStatus = statusLine();
  const flowBox = el('div', { class: 'device-code' });
  let poll = null;
  let flowId = null;

  const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

  const landed = (flow) => {
    stopPolling();
    flowId = null;
    flowBox.replaceChildren();
    const status = flowStatus(flow);
    if (status === 'connected') {
      grantedClientId = flow.clientId || grantedClientId;
      signInStatus.good(flow.user
        ? `Signed in as ${flow.user}. Zelos stays signed in on its own from here.`
        : 'Signed in. Zelos stays signed in on its own from here.');
      onConnected?.({ keyRef, provider: 'google', clientId: oauth().clientId, user: flow.user || '' });
    } else if (status === 'cancelled') {
      signInStatus.bad('Sign-in cancelled.');
    } else if (status === 'expired') {
      signInStatus.bad('The sign-in ran out of time before it finished — press the button to start again.');
    } else {
      signInStatus.bad(flow.error || flow.message || 'Google refused the sign-in.');
    }
  };

  const cancel = async () => {
    const id = flowId;
    stopPolling();
    flowId = null;
    flowBox.replaceChildren();
    signInStatus.working('Sign-in cancelled.');
    if (id) await api.cancelMailOAuth(id).catch(() => {});
  };

  /* The authorization URL is the server's: it holds a client id, a PKCE
     challenge and a `state` nonce, and nothing that is anybody's secret or
     address. https only, like the app-password link — a page that is not
     Google's is not a page to send a person to. */
  const openSignIn = (flow) => {
    const page = /^https:\/\//.test(flow.authUrl || '')
      ? el('a', { class: 'btn', href: flow.authUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open Google’s sign-in page' })
      : null;
    replace(flowBox, [
      el('p', { class: 'quiet-note', text: page
        ? 'Finish in the tab that just opened — if nothing opened, press the button. Leave this panel open.'
        : 'The server sent no sign-in page to open.' }),
      el('div', { class: 'row-inline' }, [
        page,
        button('Give up', { class: 'btn quiet', onClick: cancel }),
      ]),
    ]);
    // Opened from the click that started the flow, while that click still
    // counts as the user's own gesture; a browser that disagrees leaves the
    // link on screen to press by hand.
    page?.click();
  };

  async function start() {
    if (!address()) { signInStatus.bad('Fill in the address first — it is the mailbox being signed in to.'); return; }
    const chosen = oauth();
    if (!clientReady && !chosen.clientId) { signInStatus.bad('Zelos has no Google client to sign in with yet — paste your own under “Use your own Google Cloud client”, or use an app password instead.'); return; }
    // Read once, then gone from the DOM: the field is empty before the
    // request is answered, so nothing on this screen holds the secret after
    // the one moment it is needed.
    const clientSecret = secretInput.value;
    secretInput.value = '';
    onStart?.(chosen);
    stopPolling();
    signInStatus.working('Asking Google for a sign-in page…');
    try {
      const flow = await api.beginMailOAuth({
        provider: 'google',
        keyRef,
        email: address(),
        ...(chosen.clientId ? { clientId: chosen.clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
      flowId = flow.id;
      if (flowStatus(flow) !== 'pending') { landed(flow); return; }
      signInStatus.working('Waiting for you to finish in the browser…');
      openSignIn(flow);
      poll = setInterval(async () => {
        try {
          const now = await api.mailOAuthStatus(flowId);
          if (flowStatus(now) === 'pending') return;
          landed(now);
        } catch (err) {
          // A 404 means the server restarted or the flow expired; either way
          // there is nothing left to wait for.
          stopPolling();
          flowBox.replaceChildren();
          signInStatus.bad(err.message || 'The sign-in is no longer waiting.');
        }
      }, 1500);
    } catch (err) {
      signInStatus.bad(err.message || 'Could not start the sign-in.');
    }
  }

  const signInButton = el('div', { class: 'row-inline' }, [
    button(signedInAs ? 'Sign in again' : 'Sign in with Google', { class: 'btn solid', onClick: start }),
  ]);

  // A client of the person's own, collapsed under one link. With Zelos's own
  // client ready the fields are not offered at all: there is nothing to
  // explain and one button is the whole block.
  const ownClient = el('div', { class: 'stack' }, [
    field('Client ID', clientIdInput, {
      hint: 'From a Google Cloud project of your own: an OAuth client of type “Desktop app”, with the Gmail API switched on. Paste its client ID here.',
    }),
    field('Client secret', secretInput, {
      hint: 'Google issues desktop apps one and documents it as not actually secret. It goes once to the Zelos server on this machine, into your secret store, and is never shown again.',
    }),
    signInButton,
  ]);
  ownClient.hidden = !clientId;
  const reveal = button('Use your own Google Cloud client', {
    class: 'link',
    onClick: () => { ownClient.hidden = false; reveal.hidden = true; },
  });
  reveal.hidden = !ownClient.hidden;

  const node = el('div', { class: 'stack' }, clientReady
    ? [signInButton, signInStatus.node, flowBox]
    : [
      el('p', { class: 'quiet-note', text: 'Zelos’s own Google app is not registered yet, so signing in with Google needs a client of your own until it is.' }),
      reveal,
      ownClient,
      signInStatus.node,
      flowBox,
    ]);
  if (signedInAs) signInStatus.good(`Signed in · ${signedInAs}`);

  return {
    node,
    oauth,
    /** Stop asking the server about a sign-in nobody is looking at any more. */
    stop() { stopPolling(); flowBox.replaceChildren(); },
  };
}

function mailForm(account, { onSaved, onCancel }) {
  const draft = { ...account };
  const status = statusLine();

  const hostInput = input({ value: draft.host, placeholder: 'imap.example.com', list: 'zelos-imap-hosts' });
  const hostList = el('datalist', { id: 'zelos-imap-hosts' },
    IMAP_HINTS.map((h) => el('option', { value: h.host, label: h.label })));
  const noteLine = el('p', { class: 'field-hint', text: '' });
  const syncNote = () => {
    const hit = IMAP_HINTS.find((h) => h.host === hostInput.value.trim());
    noteLine.textContent = hit?.note || '';
  };
  hostInput.addEventListener('input', () => { draft.host = hostInput.value.trim(); syncNote(); });
  syncNote();

  const labelInput = input({ value: draft.label, placeholder: 'Work' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const userInput = input({ value: draft.user, placeholder: 'you@example.com', autocomplete: 'off' });
  userInput.addEventListener('input', () => { draft.user = userInput.value.trim(); });

  const portInput = input({ type: 'number', value: String(draft.port), min: '1', max: '65535' });
  portInput.addEventListener('input', () => { draft.port = Number(portInput.value) || 993; });

  const passInput = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    placeholder: state.secretRefs.includes(draft.keyRef) ? 'a password is stored — type a new one to replace it' : 'app password',
  });

  const mailboxInput = input({ value: (draft.mailboxes || ['INBOX']).join(', ') });
  mailboxInput.addEventListener('input', () => {
    draft.mailboxes = mailboxInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  });

  const sentInput = input({ value: draft.sentMailbox ?? 'Sent', placeholder: 'Sent' });
  sentInput.addEventListener('input', () => { draft.sentMailbox = sentInput.value.trim(); });

  const lookbackInput = input({ type: 'number', value: String(draft.lookbackDays), min: '1', max: '365' });
  lookbackInput.addEventListener('input', () => { draft.lookbackDays = Number(lookbackInput.value) || 14; });

  const maxInput = input({ type: 'number', value: String(draft.maxMessages), min: '10', max: '5000' });
  maxInput.addEventListener('input', () => { draft.maxMessages = Number(maxInput.value) || 400; });

  let secure = draft.secure !== false;

  const tlsSelect = select(TLS_CHOICES, { value: tlsChoiceFor(draft.requireTls) });
  // Read off the control at the moment it is needed rather than mirrored into a
  // variable on change: saving and testing must never be able to disagree about
  // what is on screen, and this is the one setting where disagreeing means the
  // password goes out under rules the user was never shown.
  const requireTls = () => requireTlsFor(tlsSelect.value);

  // Refs this form has stored itself since it was drawn — `state.secretRefs`
  // is refreshed by a config save, not by POST /api/secrets, so a password
  // stored on the way into "Test the connection" would otherwise still read
  // as missing when Save is pressed a moment later. Same shape as modelPanel.
  const storedHere = new Set();
  const passwordStored = () => state.secretRefs.includes(draft.keyRef) || storedHere.has(draft.keyRef);

  async function persistPassword() {
    if (!passInput.value) return;
    await api.setSecret(draft.keyRef, passInput.value);
    storedHere.add(draft.keyRef);
    passInput.value = '';
  }

  // The rule (NEEDS_PASSWORD, above): password auth, nothing typed, nothing
  // stored. Microsoft sign-in carries no password and is exempt.
  const passwordMissing = () => authMethod() === 'password' && !passInput.value && !passwordStored();

  // The picker has three entries and config has two methods: "Sign in with
  // Google" is `xoauth2` with `oauth.provider: 'google'`, so the picker value
  // is translated here and `draft.auth` only ever holds a value config
  // validates. An account with no `provider` predates Google and is Microsoft.
  const googleAccount = () => draft.auth === 'xoauth2' && draft.oauth?.provider === 'google';
  const authSelect = select(MAIL_AUTH_CHOICES, {
    value: draft.auth === 'xoauth2' ? (googleAccount() ? 'google' : 'xoauth2') : 'password',
  });
  const authMethod = () => (authSelect.value === 'password' ? 'password' : 'xoauth2');
  const provider = () => (authSelect.value === 'google' ? 'google' : 'microsoft');

  // "Sign in with Microsoft" — the one device flow, shared with the simple
  // form; see microsoftSignIn above. What it learns lands on the draft.
  // Built the way the Google block below is: whether Zelos has a Microsoft
  // client to sign in with is the server's answer, asked once about a
  // personal address for the same reason as Google's probe, and the one-time
  // setup page is the server's too (GET /api/guides). Without both, this
  // form refused a sign-in the configured client could run and its refusal
  // named a file instead of showing the page.
  let microsoft = null;
  let microsoftReady = null;
  const buildMicrosoft = () => microsoftSignIn({
    keyRef: draft.keyRef,
    user: () => draft.user,
    clientId: draft.oauth?.provider === 'google' ? '' : draft.oauth?.clientId || '',
    tenantId: draft.oauth?.tenantId || 'common',
    clientReady: microsoftReady?.clientReady === true,
    setupUrl: microsoftReady?.setupUrl || '',
    onStart: (oauth) => { draft.oauth = oauth; },
    onConnected: () => { draft.auth = 'xoauth2'; draft.oauth = microsoft.oauth(); },
  });
  async function paintMicrosoft() {
    if (microsoftReady === null) {
      credentialSlot.replaceChildren(el('p', { class: 'quiet-note', text: 'Checking whether Zelos can sign in to Microsoft on this machine…' }));
      try {
        const [found, links] = await Promise.all([api.guessMail('you@outlook.com'), guideLinks()]);
        microsoftReady = { clientReady: found.clientReady === true, setupUrl: links.microsoftSetup || '' };
      } catch {
        microsoftReady = { clientReady: false, setupUrl: '' };
      }
      // The picker moved on while the question was out.
      if (authMethod() !== 'xoauth2' || provider() !== 'microsoft') return;
    }
    microsoft = microsoft || buildMicrosoft();
    credentialSlot.replaceChildren(microsoft.node);
  }

  // "Sign in with Google" — the same block the simple form shows, built when
  // the picker first lands on it. Whether Zelos has a Google client to sign
  // in with is the server's answer, not this page's guess: the default client
  // is a constant in core/sources/oauth.mjs, and POST /api/mail/guess is the
  // one route that reports it (`clientReady`). The answer is a property of
  // the server's config, not of any address, so it is asked about a Gmail
  // placeholder rather than the account's own — a Workspace domain whose
  // records do not resolve would otherwise read as "no client" when the
  // client is fine — and asked once.
  let google = null;
  let googleReady = null;
  const buildGoogle = () => googleSignIn({
    keyRef: draft.keyRef,
    email: () => draft.user,
    clientReady: googleReady === true,
    clientId: googleAccount() ? draft.oauth?.clientId || '' : '',
    signedInAs: googleAccount() ? draft.user : '',
    onStart: (oauth) => { draft.oauth = oauth; },
    onConnected: (oauth) => { draft.auth = 'xoauth2'; draft.oauth = { provider: 'google', clientId: oauth.clientId }; },
  });
  const activeOAuth = () => (provider() === 'google' ? google?.oauth() ?? draft.oauth : microsoft?.oauth() ?? draft.oauth);
  async function paintGoogle() {
    if (googleReady === null) {
      credentialSlot.replaceChildren(el('p', { class: 'quiet-note', text: 'Checking whether Zelos can sign in to Google on this machine…' }));
      try {
        googleReady = (await api.guessMail('you@gmail.com')).clientReady === true;
      } catch {
        googleReady = false;
      }
      // The picker moved on while the question was out.
      if (authMethod() !== 'xoauth2' || provider() !== 'google') return;
    }
    google = google || buildGoogle();
    credentialSlot.replaceChildren(google.node);
  }

  const passwordBlock = el('div', { class: 'stack' }, [
    field('Password', passInput, {
      hint: secretStoreNotes(state.health?.backend?.name).password,
    }),
  ]);

  const credentialSlot = el('div', {});
  const paintCredential = () => {
    const xo = authMethod() === 'xoauth2';
    const viaGoogle = xo && provider() === 'google';
    if (viaGoogle) paintGoogle();
    else if (xo) paintMicrosoft();
    else credentialSlot.replaceChildren(passwordBlock);
    tlsSelect.closest('.field')?.toggleAttribute('hidden', xo);
    if (!xo || viaGoogle) microsoft?.stop();
    if (!viaGoogle) google?.stop();
  };
  authSelect.addEventListener('change', () => {
    draft.auth = authMethod();
    paintCredential();
  });

  const node = el('div', { class: 'account-form' }, [
    hostList,
    field('Name it', labelInput),
    field('IMAP host', hostInput),
    noteLine,
    el('div', { class: 'grid-2' }, [
      field('Port', portInput),
      checkbox('TLS on connect (port 993)', { checked: secure, onChange: (v) => { secure = v; } }),
    ]),
    field('Sending your password', tlsSelect, {
      hint: 'Zelos will not send your password until the connection is encrypted. Left to decide, it insists on that everywhere except a server running on this machine — which is where Proton Bridge and its kind live, and the only reason an unencrypted connection is still offered at all. Allow one anywhere else and anyone sharing your network, or sitting anywhere between you and your mail server, can read the password and the mail.',
    }),
    field('Username', userInput),
    field('How Zelos signs in', authSelect, {
      hint: 'Gmail and Google Workspace can sign in with Google; Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live and MSN mail on 16 September 2024, and app passwords stopped working with them. Everything else takes a password — Gmail and Yahoo want an app password rather than your account one.',
    }),
    credentialSlot,
    el('div', { class: 'grid-2' }, [
      field('Mailboxes', mailboxInput, { hint: 'Comma separated.' }),
      field('Look back (days)', lookbackInput),
    ]),
    field('Sent folder', sentInput, {
      hint: 'Read as well as the mailboxes above, because “you promised” is mined from what you wrote — without it that half of the board cannot exist. Gmail calls it “[Gmail]/Sent Mail”, Microsoft 365 “Sent Items”, iCloud “Sent Messages”. Press “Test the connection” and Zelos fills in whatever this server flags as its own. Leave it blank to read nothing outbound.',
    }),
    field('Most messages per sweep', maxInput),
    el('div', { class: 'row-inline' }, [
      button('Save account', {
        class: 'btn solid',
        onClick: async () => {
          if (!draft.host || !draft.user) {
            status.bad('A host and a username are both required.');
            return;
          }
          if (passwordMissing()) {
            status.bad(NEEDS_PASSWORD);
            return;
          }
          status.working('Saving…');
          try {
            await persistPassword();
            const others = (state.config.mail || []).filter((m) => m.id !== draft.id);
            const patch = {
              mail: [...others, { ...draft, secure, requireTls: requireTls(), sentMailbox: sentInput.value.trim() }],
            };
            // The second writer for identity.email — see defaultIdentityEmail
            // above. An install that predates the You panel has `''` there, and
            // `sameEmail(a, '')` is false for every message, so the scorer's
            // To:/Cc: branches are dead and the sweep does not know which
            // replies are the user's own. This is the moment the address is
            // both known and confirmed by hand, so it is the moment to adopt
            // it — announced rather than silent, and only when nothing is set.
            const known = String(state.config?.identity?.email ?? '').trim();
            const adopted = !known && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.user) ? draft.user : '';
            if (adopted) patch.identity = { email: adopted };
            await saveConfig(patch);
            status.good(adopted
              ? `Saved. Zelos will also treat ${adopted} as your own address — change it under Settings → You.`
              : 'Saved.');
            onSaved();
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Test the connection', {
        class: 'btn quiet',
        onClick: async () => {
          if (passwordMissing()) {
            status.bad(NEEDS_PASSWORD);
            return;
          }
          status.working(`Connecting to ${draft.host}…`);
          try {
            await persistPassword();
            // `requireTls` goes with it, or this is not a test of this account.
            // Without it the button connected under looser rules than the sweep
            // will, so the one moment a user is told "this works" was the moment
            // least like the 07:00 run — and the only one they are awake for.
            const result = await api.testMail({
              host: draft.host,
              port: draft.port,
              secure,
              user: draft.user,
              keyRef: draft.keyRef,
              requireTls: requireTls(),
              // And how it signs in, or the button tests a password account
              // that does not exist: a signed-in mailbox has no password to
              // be missing, and the sweep will use the grant.
              ...(authMethod() === 'xoauth2' ? { auth: 'xoauth2', oauth: activeOAuth() } : {}),
            });
            if (result.ok) {
              const seen = `Connected. ${plural((result.mailboxes || []).length, 'mailbox', 'mailboxes')} visible.`;
              // The reader for the SPECIAL-USE flag: it has been on the wire and
              // in this response object all along with nowhere to land.
              const suggested = sentMailboxFromTest(result.mailboxes, sentInput.value);
              if (suggested && suggested !== sentInput.value.trim()) {
                sentInput.value = suggested;
                draft.sentMailbox = suggested;
                status.good(`${seen} This server calls its sent folder “${suggested}” — filled in below. Save the account to keep it.`);
              } else {
                status.good(seen);
              }
            } else status.bad(result.error || 'The server refused the connection.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Cancel', { class: 'btn quiet', onClick: onCancel }),
    ]),
    status.node,
  ]);
  // Paint the slot for the state the form OPENS in, or an existing account
  // shows no password field and no sign-in until the picker above is touched.
  // After the tree is built, so the TLS field's initial hide can find it.
  paintCredential();
  return node;
}

/* ---------------------------------------------------------- simple setup */

/**
 * The Connect sequence, with nothing on screen in it.
 *
 * One address and one pasted app password have to become a working account.
 * The full form asked for that in five steps — know the host, store the
 * password, Test, Save, fix the sent folder — and the operator's own first
 * mailbox managed four of them. This is those steps in their only sensible
 * order, as one call: store the password under the account's own keyRef
 * (secrets travel only through POST /api/secrets, so the test has to name a
 * ref that already holds it), test under exactly the rules the sweep will
 * use, take the sent folder from the server's SPECIAL-USE flag, save. The
 * account that comes out is the full form's blank with the guess filled in,
 * so it validates the same way and sweeps the same way.
 *
 * `requireTls` is what the full form's Test sends for a new account: its
 * select opens on "decide from the address", and `requireTlsFor('auto')` is
 * that choice's stored value — encryption required everywhere except a server
 * on this machine. Proton Bridge, the one provider that needs anything else,
 * never reaches this call; the simple form sends it to the full one.
 *
 * Kept free of DOM so it can be run end to end against a fake fetch, the way
 * the store is tested, rather than pinned as text.
 */
export async function connectSimpleMail({ id, keyRef, email, password = '', guess, auth = 'password', oauth = null }) {
  if (auth === 'password' && password) await api.setSecret(keyRef, password);
  const requireTls = requireTlsFor('auto');
  const secure = guess.secure !== false;
  const result = await api.testMail({
    host: guess.host,
    port: guess.port,
    secure,
    user: email,
    keyRef,
    requireTls,
    ...(auth === 'xoauth2' ? { auth, oauth } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error || 'The server refused the connection.' };

  const sentMailbox = sentMailboxFromTest(result.mailboxes, '');
  const account = {
    id,
    enabled: true,
    // The list shows `label || user`, so a provider nobody here knows is
    // better named by the address than by a bare domain.
    label: guess.known ? guess.label : '',
    host: guess.host,
    port: guess.port,
    secure,
    requireTls,
    user: email,
    auth,
    oauth: auth === 'xoauth2' ? oauth : null,
    keyRef,
    mailboxes: ['INBOX'],
    sentMailbox,
    lookbackDays: 14,
    maxMessages: 400,
  };
  const others = (state.config?.mail || []).filter((m) => m.id !== id);
  const patch = { mail: [...others, account] };
  // The same adoption rule as the full form's Save: the address is both
  // known and confirmed by hand at this moment, so it becomes identity.email
  // — only when nothing is set, and announced rather than silent.
  const known = String(state.config?.identity?.email ?? '').trim();
  const adopted = !known && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
  if (adopted) patch.identity = { email: adopted };
  await saveConfig(patch);
  return { ok: true, account, mailboxes: (result.mailboxes || []).length, sentMailbox, adopted };
}

/**
 * Connecting a mailbox as one field, one button, one paste and Connect.
 *
 * People expect "Sign in with Google", and for Gmail and Google Workspace it
 * is what they get when Zelos has a Google client to sign in with — first,
 * above the app-password path, which stays one link away because it is the
 * floor: a provider that offers nothing else (iCloud, Yahoo, Fastmail, a
 * server of one's own) still connects with one. Until the client ships, the
 * app password IS the path and the sign-in lives under "For developers".
 * The address is typed once; the server says which provider it is and
 * whether it signs in (POST /api/mail/guess, so the address never sits in a
 * URL); one button opens the provider's own sign-in page, or the exact page
 * where it creates an app password; Connect tests, finds the sent folder and
 * saves in one go.
 *
 * What the card says is written for someone who has never heard of IMAP.
 * The server's own note for the provider, its host and port, and the full
 * form all still exist — under "Server settings (for experts)", which opens
 * BENEATH the card and leaves the address and the card exactly where they
 * were when it closes. The old Advanced replaced the whole card and offered
 * Cancel as the only way back, which threw away the address a person had
 * just typed. There is exactly one route to the full form at a time: the
 * link under the address before a card is up, the card's own button after.
 * Microsoft's personal domains get the same sign-in block the full form
 * shows, since there is no password to paste; Proton gets its Bridge note
 * and the full form, because Bridge's own host, port and password are the
 * whole of that setup.
 */
export function simpleMailForm({ onSaved, onCancel }) {
  const id = randomId('m');
  const keyRef = `mail.${id}`;
  const status = statusLine();
  let guess = null;        // the server's answer, for the address it was asked about
  let microsoft = null;    // the sign-in block, once the guess says xoauth2
  let google = null;       // the sign-in block, once the guess says signIn: 'google'
  let signedIn = false;
  // The server's own words about the provider — host, port, how it knows,
  // the sentence about IMAP — shown with the expert form and nowhere else.
  let expertNote = null;
  // Whichever sign-in block the card is showing; at most one is built.
  const signInBlock = () => google || microsoft;
  // A Google sign-in that finished is the account's auth, whatever the guess
  // said about passwords; nothing else changes what the guess said.
  const viaGoogle = () => guess?.signIn === 'google' && signedIn;

  const emailInput = input({
    type: 'email',
    placeholder: 'you@example.com',
    autocomplete: 'off',
    spellcheck: 'false',
    autofocus: true,
  });
  const passInput = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    placeholder: 'paste the app password',
  });
  const card = el('div', { class: 'chosen' });
  card.hidden = true;
  // The full form opens here, under the card, and closes back to nothing.
  const expertSlot = el('div', { class: 'editor' });
  // The "Stuck?" line: about email in general until the guess lands, then
  // about the provider it named — its label, never the address.
  const helpSlot = el('div', {}, [askClaude({ step: 'email' })]);

  const email = () => emailInput.value.trim();

  // Same shape as mailForm: a password this form stored itself counts, since
  // `state.secretRefs` is refreshed by a config save and not by POST
  // /api/secrets — and the same rule, in plainer words.
  const storedHere = new Set();
  const passwordMissing = () => !passInput.value && !storedHere.has(keyRef);
  // The password box, when the card has folded it away: Connect opens it
  // before it asks for anything, so "paste it here" is never about a box the
  // person cannot see.
  let revealPassword = () => {};

  /** What the full form opens on: everything the guess found, and the typed address. */
  const prefill = () => ({
    id,
    keyRef,
    user: email(),
    label: guess?.known ? guess.label : '',
    host: guess?.host || '',
    port: guess?.port || 993,
    secure: guess ? guess.secure !== false : true,
    ...(guess?.auth === 'xoauth2' || viaGoogle() ? { auth: 'xoauth2', oauth: signInBlock()?.oauth() ?? null } : {}),
  });

  /**
   * The full form, beneath the card. A password Connect already stored has
   * to count in the full form, whose passwordStored() reads
   * state.secretRefs. One GET /api/config is what makes that true; its
   * failure leaves the form to ask again, which is the worse of two honest
   * outcomes and not a wrong one. Pressing the button again closes it.
   */
  async function openAdvanced() {
    if (expertSlot.children.length) { expertSlot.replaceChildren(); return; }
    microsoft?.stop();
    google?.stop();
    if (storedHere.size) await loadConfig().catch(() => {});
    expertSlot.replaceChildren(mailForm({
      enabled: true,
      label: '',
      host: '',
      port: 993,
      secure: true,
      // Null, not false: a new account has not excused anything yet, and the
      // blank this form opens on has to be the same blank core/config.mjs
      // would have written.
      requireTls: null,
      user: '',
      mailboxes: ['INBOX'],
      sentMailbox: 'Sent',
      lookbackDays: 14,
      maxMessages: 400,
      ...prefill(),
    }, {
      onSaved,
      onCancel: () => expertSlot.replaceChildren(),
    }));
    if (expertNote) expertSlot.appendChild(expertNote);
  }

  async function lookUp() {
    const address = email();
    if (!address || guess?.for === address) return;
    status.working('Working out who provides your email…');
    try {
      const [found, links] = await Promise.all([api.guessMail(address), guideLinks()]);
      guess = { ...found, for: address, setupUrl: links.microsoftSetup || '' };
      status.clear();
      paintCard();
    } catch (err) {
      status.bad(err.message);
    }
  }

  async function connect() {
    if (!guess || guess.for !== email()) await lookUp();
    if (!guess || !guess.host) return;
    const auth = viaGoogle() ? 'xoauth2' : guess.auth;
    if (auth === 'password' && passwordMissing()) {
      revealPassword();
      status.bad(needsPassword(guess));
      return;
    }
    if (guess.auth === 'xoauth2' && !signedIn) {
      status.bad('Press Sign in with Microsoft first — a personal Microsoft mailbox has no password to paste.');
      return;
    }
    status.working(`Connecting to ${guess.known ? guess.label : guess.host}…`);
    try {
      // A signed-in mailbox carries no password, whatever was pasted before
      // the sign-in finished.
      const password = auth === 'xoauth2' ? '' : passInput.value;
      const outcome = await connectSimpleMail({
        id,
        keyRef,
        email: email(),
        password,
        guess,
        auth,
        oauth: auth === 'xoauth2' ? signInBlock()?.oauth() ?? null : null,
      });
      // Whatever the server said about the connection, the password it was
      // said about is stored now; a retry with the field left empty must
      // not be refused for a secret the server already holds.
      if (password) {
        storedHere.add(keyRef);
        passInput.value = '';
        passInput.placeholder = 'a password is saved — paste a new one to replace it';
      }
      // The card's own expert button is still on screen, and it is the one
      // way to the full form: a second button under the error would be two
      // routes, one line apart.
      if (!outcome.ok) {
        status.bad(outcome.error);
        return;
      }
      const sent = outcome.sentMailbox ? `sent folder “${outcome.sentMailbox}”` : 'no sent folder found';
      status.good(`Connected · ${plural(outcome.mailboxes, 'mailbox', 'mailboxes')} · ${sent}`
        + (outcome.adopted ? ` · Zelos will also treat ${outcome.adopted} as your own address — change it under Settings → You.` : ''));
      onSaved();
    } catch (err) {
      status.bad(err.message);
    }
  }

  const formAdvanced = button('Server settings (for experts)', { class: 'link', onClick: openAdvanced });

  function paintCard() {
    microsoft?.stop();
    microsoft = null;
    google?.stop();
    google = null;
    signedIn = false;
    revealPassword = () => {};
    expertNote = null;
    expertSlot.replaceChildren();
    card.hidden = !guess;
    // One route to the full form at a time: before a guess it is the link under
    // the address; once a card is up, the card carries its own. Two expert
    // buttons on one screen read as two different things.
    formAdvanced.hidden = Boolean(guess);
    if (!guess) { card.replaceChildren(); return; }
    replace(helpSlot, [askClaude({
      step: 'email',
      provider: guess.known ? guess.label : 'unknown',
      signIn: guess.signIn || null,
      clientReady: guess.clientReady === true,
    })]);

    // How the server knows: a custom domain on Workspace or 365 is named
    // from its mail records, and a domain with an IMAP SRV record from that.
    // The line is mono and technical, so a recognised provider does not show
    // it at all; a guessed host is the one fact a person can check.
    const via = guess.via === 'mx' ? ' · found through your domain\'s mail records'
      : guess.via === 'srv' ? ' · advertised by your domain'
        : '';
    const head = el('div', { class: 'chosen-head' }, [
      el('span', { class: 'chosen-label', text: guess.known ? guess.label : (guess.host ? 'A provider Zelos does not know' : 'Not an address Zelos can read') }),
      guess.host && !guess.known ? el('span', { class: 'mono account-host', text: `${guess.host}:${guess.port}${via}` }) : null,
    ]);
    const note = el('p', { class: 'quiet-note', text: plainProviderNote(guess) });
    // The server's own words about this provider — host, port, how it knows,
    // the sentence about IMAP — kept for the expert, under the expert form.
    expertNote = guess.note
      ? el('p', { class: 'quiet-note', text: `${guess.host}:${guess.port}${via}. ${guess.note}` })
      : null;

    if (!guess.host) {
      card.replaceChildren(head, el('p', { class: 'quiet-note', text: guess.note }));
      return;
    }

    if (guess.auth === 'bridge') {
      replace(card, [head, note, el('div', { class: 'row-inline' }, [
        button('Continue with Bridge settings', { class: 'btn solid', onClick: openAdvanced }),
      ])]);
      return;
    }

    const advanced = button('Server settings (for experts)', {
      // Prominent where the guess is only a guess: the full form is where a
      // wrong host gets corrected, and a user whose provider is unknown is
      // the user most likely to need it.
      class: guess.known ? 'btn quiet' : 'btn',
      onClick: openAdvanced,
    });
    const experts = el('div', { class: 'row-inline' }, [advanced]);

    if (guess.auth === 'xoauth2') {
      microsoft = microsoftSignIn({
        keyRef,
        user: email,
        // The shipped client, when the server has one: the registration form
        // is hidden and the button is the whole block.
        clientReady: guess.clientReady === true,
        setupUrl: guess.setupUrl,
        linkShownAbove: guess.clientReady !== true,
        onConnected: () => { signedIn = true; },
      });
      replace(card, [
        head,
        note,
        guess.clientReady ? null : el('div', { class: 'row-inline' }, [setupLink(guess.setupUrl)]),
        microsoft.node,
        el('div', { class: 'row-inline' }, [
          button('Connect', { class: 'btn solid', onClick: connect }),
        ]),
        experts,
      ]);
      return;
    }

    // The desktop shell hands a target=_blank https link to the system
    // browser (desktop/guard.js), which is exactly where a sign-in page
    // belongs: the board's window loads nothing but the board.
    const page = /^https:\/\//.test(guess.appPasswordUrl || '')
      ? el('a', { class: 'btn', href: guess.appPasswordUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get an app password' })
      : null;
    const passwordPath = el('div', { class: 'stack' }, [
      page ? el('div', { class: 'row-inline' }, [page]) : null,
      page ? el('p', { class: 'quiet-note', text: appPasswordSteps(guess) }) : null,
      field('App password', passInput, { hint: plainSecretNotes(state.health?.backend?.name).field }),
    ]);

    // Gmail and Workspace: sign in first when Zelos can, and the app password
    // one link beneath. The password path is the same nodes the branch below
    // paints, hidden until asked for — and hidden again once a sign-in has
    // landed, because Connect will use the grant and a password field under
    // a "Signed in" line reads as a second thing to do. Without a Google
    // client the order flips: the password path is the card, and the
    // sign-in — with its "paste your own client" fields — is the drawer.
    if (guess.signIn === 'google') {
      const ready = guess.clientReady === true;
      passwordPath.hidden = ready;
      const usePassword = button('Use an app password instead', {
        class: 'link',
        onClick: () => { passwordPath.hidden = false; usePassword.hidden = true; },
      });
      usePassword.hidden = !ready;
      revealPassword = () => { passwordPath.hidden = false; usePassword.hidden = true; };
      google = googleSignIn({
        keyRef,
        email,
        clientReady: ready,
        onConnected: () => { signedIn = true; passwordPath.hidden = true; usePassword.hidden = true; },
      });
      replace(card, ready
        ? [
          head,
          note,
          google.node,
          usePassword,
          passwordPath,
          el('div', { class: 'row-inline' }, [
            button('Connect', { class: 'btn solid', onClick: connect }),
          ]),
          experts,
        ]
        : [
          head,
          note,
          passwordPath,
          el('div', { class: 'row-inline' }, [
            button('Connect', { class: 'btn solid', onClick: connect }),
          ]),
          fold('For developers', google.node),
          experts,
        ]);
      return;
    }
    // Through dom.js's replace(), not the DOM's own replaceChildren: a null
    // child is skipped there and is the text "null" here, which is what the
    // card printed where this link goes for every provider without a page.
    replace(card, [
      head,
      note,
      passwordPath,
      el('div', { class: 'row-inline' }, [
        button('Connect', { class: 'btn solid', onClick: connect }),
      ]),
      experts,
    ]);
  }

  emailInput.addEventListener('change', lookUp);
  emailInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); lookUp(); }
  });
  passInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); connect(); }
  });

  return el('div', { class: 'account-form' }, [
    field('Your email address', emailInput, {
      hint: 'Your address stays on this computer.',
    }),
    card,
    expertSlot,
    status.node,
    el('div', { class: 'row-inline' }, [
      formAdvanced,
      button('Cancel', { class: 'btn quiet', onClick: () => { microsoft?.stop(); google?.stop(); onCancel(); } }),
    ]),
    helpSlot,
  ]);
}

export function mailPanel({ compact = false, onDone = null, rerender, connectionId = null } = {}) {
  const accounts = state.config?.mail || [];
  const wrap = el('div', { class: 'panel panel-mail' });

  if (!compact) {
    wrap.appendChild(el('p', { class: 'panel-lede', text: 'The email account Zelos reads. It only looks: nothing it reads gets marked read, moved or deleted, and what it reads is kept on this computer and nowhere else.' }));
  }

  const list = el('div', { class: 'stack' }, accounts.length
    ? accounts.map((account) => el('div', connectionCardProps(account, connectionId), [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: account.label || account.user }),
        account.enabled === false ? el('span', { class: 'chip', text: 'off' }) : null,
      ]),
      el('p', { class: 'quiet-note', text: `${account.user} · the last ${account.lookbackDays} days` }),
      sourceStatusLine(account.id, 'mail'),
      account.id === connectionId ? connectionRecovery(account.id, 'mail') : null,
      el('div', { class: 'row-inline' }, [
        button(account.enabled === false ? 'Enable' : 'Disable', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.mail || []).map((m) => (m.id === account.id ? { ...m, enabled: account.enabled === false } : m));
            await saveConfig({ mail: next });
            rerender?.();
          },
        }),
        button('Edit', {
          class: 'btn quiet',
          onClick: () => {
            editor.replaceChildren(mailForm(account, {
              onSaved: () => rerender?.(),
              onCancel: () => editor.replaceChildren(),
            }));
          },
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.mail || []).filter((m) => m.id !== account.id);
            await saveConfig({ mail: next });
            await api.deleteSecret(account.keyRef).catch(() => {});
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'No email account connected yet.' }));

  const editor = el('div', { class: 'editor' });
  // The panel's own "Stuck?" line. The simple form carries one of its own,
  // about the provider once it is known, so this one steps aside while the
  // form is open: two on one screen read as two different things.
  const help = askClaude({ step: 'email' });

  // The simple form, which carries the full one beneath its own card — on the
  // id and keyRef it minted, so a password Connect already stored is the
  // password the full form saves.
  const addButton = button('Add an email account', {
    class: 'btn solid',
    onClick: () => {
      help.hidden = true;
      editor.replaceChildren(simpleMailForm({
        onSaved: () => { onDone?.(); rerender?.(); },
        onCancel: () => { editor.replaceChildren(); help.hidden = false; },
      }));
    },
  });

  wrap.appendChild(list);
  if (connectionId && !accounts.some(account => account.id === connectionId)) wrap.prepend(missingConnection());
  wrap.appendChild(el('div', { class: 'row-inline' }, addButton));
  wrap.appendChild(editor);
  wrap.appendChild(help);
  return wrap;
}

/* ------------------------------------------------------------- calendars */

/**
 * The four ways in, by the name a person knows their calendar by.
 *
 * Each guide fixes the connector kind and, where there is only one right
 * answer, the address; the rest of the form is the same form, so a guided
 * path tests and saves through exactly the code the expert one does. "Something
 * else" is the expert form unchanged, under that label. The iCloud address is
 * the host Apple publishes for CalDAV; core/sources/caldav.mjs discovers the
 * account's calendars from it, across the partition hop Apple answers with.
 */
export const CALENDAR_GUIDES = [
  {
    id: 'google',
    kind: 'ics',
    title: 'Google Calendar',
    blurb: 'The calendar that goes with a Gmail address.',
    label: 'Google Calendar',
    steps: [
      ['1. Open ', { link: ['google', 'settings'], text: 'Google Calendar on the web' }, '.'],
      '2. On the left, click your calendar.',
      '3. Scroll to ‘Secret address in iCal format’ and copy it.',
      '4. Paste it here.',
    ],
    urlLabel: 'The secret address',
    urlPlaceholder: 'https://…/calendar/ical/…',
  },
  {
    id: 'icloud',
    kind: 'caldav',
    title: 'iPhone or Mac (iCloud)',
    blurb: 'The calendar on your iPhone, iPad or Mac.',
    label: 'iCloud',
    url: ['icloud', 'caldav'],
    steps: [
      'Zelos needs two things: your Apple ID email, and an app-specific password.',
      ['To make the password: go to ', { link: ['icloud', 'appPasswords'], text: 'appleid.apple.com' }, ' → Sign-In and Security → App-Specific Passwords → name it Zelos. Copy it and paste it below.'],
    ],
    userLabel: 'Your Apple ID email',
    passLabel: 'The app-specific password',
  },
  {
    id: 'outlook',
    kind: 'ics',
    title: 'Outlook',
    blurb: 'Outlook.com, Hotmail, or a work calendar in Outlook.',
    label: 'Outlook',
    steps: [
      ['1. Open ', { link: ['outlook', 'calendar'], text: 'Outlook.com' }, ' → Settings → Calendar → Shared calendars.'],
      '2. Under ‘Publish a calendar’, pick your calendar and press Publish.',
      '3. Copy the ICS link and paste it here.',
    ],
    urlLabel: 'The ICS link',
    urlPlaceholder: 'https://…/owa/calendar/…',
  },
  {
    id: 'other',
    kind: null,
    title: 'Something else',
    blurb: 'A calendar link, an account, or a file on this computer.',
    label: '',
    steps: [],
  },
];

/** What the list calls a kind, instead of the connector's id. */
const KIND_WORDS = { ics: 'a calendar link', caldav: 'a calendar account', file: 'a file on this computer' };

/**
 * The calendar editor.
 *
 * The kind picker is the registry's `calendars` connectors and their own
 * `option` sentences — it used to be three `<option>` elements written out here,
 * which is why a fourth calendar kind would have been invisible to the only
 * screen that can create one.
 *
 * `fields[]` plays no part: a calendar's address, username and keyRef are the
 * ENVELOPE core/config.mjs stores for every calendar, not per-connector
 * settings, and all three calendar connectors declare `fields: []` for the same
 * reason core/connectors/imap.mjs does. What the manifest does drive is the
 * credential — whether there is one at all, what it is called, and what to say
 * about it — and that is the part that was wrong before: `file` has
 * `credential: null`, and this form asked for a username and password to read a
 * path on the user's own disk.
 *
 * A `guide` (one of CALENDAR_GUIDES) turns the form into the steps for one
 * named calendar: the kind is fixed, the address is prefilled where there is
 * one, and the one button runs the same Test and then the same Save.
 */
export function calendarForm(calendar, { manifests = [], guide = null, links = {}, onSaved, onCancel }) {
  const draft = { ...calendar };
  const status = statusLine();
  const options = kindOptions(manifests, 'calendars');
  const guided = guide && guide.kind ? guide : null;
  // A guide names its links by key; the addresses are the server's.
  const linkFor = (key) => String(links?.calendars?.[key[0]]?.[key[1]] || '');
  if (guided) {
    draft.kind = guided.kind;
    if (guided.url && !draft.url) draft.url = linkFor(guided.url);
    if (guided.label && !draft.label) draft.label = guided.label;
  }

  const labelInput = input({ value: draft.label, placeholder: 'Personal' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const kindSelect = select(options, { value: draft.kind || options[0]?.value || '' });

  const urlInput = input({ value: draft.url, placeholder: guided?.urlPlaceholder || 'https://…  or  /Users/you/calendar.ics' });
  urlInput.addEventListener('input', () => { draft.url = urlInput.value.trim(); });

  const userInput = input({ value: draft.user || '', placeholder: guided?.userLabel ? 'you@icloud.com' : 'only for a protected address', autocomplete: 'off' });
  userInput.addEventListener('input', () => { draft.user = userInput.value.trim(); });

  /* The sign-in half of the form, redrawn whenever the kind changes. Both
     controls live or die together: a username with no password to go with it
     authenticates nothing, so a connector that declares no credential gets
     neither, and says so instead. */
  const signIn = el('div', null);
  let credential = null;
  function drawCredential() {
    const manifest = manifestFor(manifests, kindSelect.value);
    credential = credentialControl(manifest, {
      keyRef: draft.keyRef || `calendar.${draft.id}`,
      stored: state.secretRefs.includes(draft.keyRef),
    });
    if (credential && guided?.passLabel) {
      // The same input and keyRef the connector asked for, labelled in the
      // guide's words rather than the manifest's and the store's.
      credential.node = field(guided.passLabel, credential.input, {
        hint: plainSecretNotes(state.health?.backend?.name).field,
      });
    }
    signIn.replaceChildren(...(credential
      ? [field(guided?.userLabel || 'Username', userInput), credential.node]
      : guided
        ? []
        : [el('p', { class: 'quiet-note', text: `${manifest?.option || 'This kind of calendar'} needs no username and no password.` })]));
  }
  kindSelect.addEventListener('change', drawCredential);
  drawCredential();

  /* The kind is read off the control where it is needed rather than mirrored
     into `draft` on change — the same rule the TLS selector states above, and
     for a version of the same reason. A mirror starts out of step: a calendar
     saved with no kind at all shows the first option and would have been stored
     as `kind: ''` unless the user happened to touch the picker, which
     `validateConfig` then refuses with a message about a control they never
     saw. */
  const kindNow = () => kindSelect.value;

  async function persistPassword() {
    if (!credential?.input.value) return;
    if (!draft.keyRef) draft.keyRef = `calendar.${draft.id}`;
    await api.setSecret(draft.keyRef, credential.input.value);
    credential.input.value = '';
  }

  async function runSave() {
    if (!draft.url) {
      status.bad(guided ? 'Paste the address first.' : 'An address is required.');
      return false;
    }
    status.working('Saving…');
    try {
      await persistPassword();
      const others = (state.config.calendars || []).filter((c) => c.id !== draft.id);
      await saveConfig({ calendars: [...others, { ...draft, kind: kindNow() }] });
      status.good('Saved.');
      onSaved();
      return true;
    } catch (err) {
      status.bad(err.message);
      return false;
    }
  }

  async function runTest() {
    if (!draft.url) {
      status.bad(guided ? 'Paste the address first.' : 'An address is required.');
      return false;
    }
    status.working('Fetching…');
    try {
      await persistPassword();
      // The kind goes with it, from the same control the save reads, or
      // this is a test of a different calendar from the one about to be
      // stored — the mail form makes the same point about requireTls.
      const result = await api.testCalendar({
        kind: kindNow(),
        url: draft.url,
        user: draft.user,
        keyRef: draft.keyRef,
      });
      if (result.ok) {
        const name = result.calendars?.[0]?.name || 'calendar';
        status.good(`${name}: ${plural(result.events ?? 0, 'appointment')} found.`);
        return true;
      }
      status.bad(result.error || 'Nothing came back.');
      return false;
    } catch (err) {
      status.bad(err.message);
      return false;
    }
  }

  const stepNodes = (guided?.steps || []).map((step) => el('p', {}, Array.isArray(step)
    ? step.map((part) => (typeof part === 'string' ? part : outLink(linkFor(part.link), part.text)))
    : step));

  if (guided) {
    return el('div', { class: 'account-form' }, [
      el('div', { class: 'chosen-head' }, [el('span', { class: 'chosen-label', text: guided.title })]),
      el('div', { class: 'stack' }, stepNodes),
      guided.urlLabel ? field(guided.urlLabel, urlInput) : null,
      // A secret address needs no password, so the optional one a published
      // calendar MAY take is under Advanced; iCloud's is the card.
      guided.passLabel ? signIn : null,
      el('div', { class: 'row-inline' }, [
        // Test, then Save — the two buttons below, pressed in the only
        // sensible order, as one.
        button('Check it works and save', {
          class: 'btn solid',
          onClick: async () => { if (await runTest()) await runSave(); },
        }),
        button('Cancel', { class: 'btn quiet', onClick: onCancel }),
      ]),
      status.node,
      fold('Advanced', [
        field('Name it', labelInput),
        field('Kind', kindSelect),
        guided.urlLabel ? null : field('Address', urlInput, { hint: 'webcal:// links work; Zelos rewrites them to https.' }),
        guided.passLabel ? null : signIn,
      ]),
    ]);
  }

  return el('div', { class: 'account-form' }, [
    field('Name it', labelInput),
    field('Kind', kindSelect),
    field('Address', urlInput, { hint: 'webcal:// links work; Zelos rewrites them to https.' }),
    signIn,
    el('div', { class: 'row-inline' }, [
      button('Save calendar', { class: 'btn solid', onClick: runSave }),
      button('Test it', { class: 'btn quiet', onClick: runTest }),
      button('Cancel', { class: 'btn quiet', onClick: onCancel }),
    ]),
    status.node,
  ]);
}

/**
 * Open an editor once the registry has answered.
 *
 * Every form below is a pure function of the manifests, which arrive over HTTP —
 * so the fetch happens on the click that needs it rather than during a render.
 * A render that awaited would either block the panel or paint a picker with
 * nothing in it, and a picker with nothing in it is how a user concludes their
 * build supports no calendars.
 */
async function openEditor(editor, status, build) {
  status.working('Reading what this build can connect to…');
  try {
    const [manifests, links] = await Promise.all([connectorManifests(), guideLinks()]);
    status.clear();
    editor.replaceChildren(build(manifests, links));
  } catch (err) {
    status.bad(`Zelos could not say what kinds of calendar it can read: ${err.message}`);
  }
}

export function calendarPanel({ compact = false, onDone = null, rerender, connectionId = null } = {}) {
  const calendars = state.config?.calendars || [];
  const wrap = el('div', { class: 'panel panel-calendars' });
  const editor = el('div', { class: 'editor' });
  const status = statusLine();
  // The "Stuck?" line, redrawn for the calendar a card names once one is pressed.
  const helpSlot = el('div', {}, [askClaude({ step: 'calendar' })]);

  if (!compact) {
    wrap.appendChild(el('p', { class: 'panel-lede', text: 'Add your calendar, and Zelos knows what is coming. Times are kept exactly as your calendar has them, so an appointment at 2pm stays at 2pm wherever this computer thinks it is.' }));
  }

  wrap.appendChild(el('div', { class: 'stack' }, calendars.length
    ? calendars.map((calendar) => el('div', connectionCardProps(calendar, connectionId), [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: calendar.label || calendar.url }),
        el('span', { class: 'quiet-note', text: KIND_WORDS[calendar.kind] || calendar.kind }),
      ]),
      el('p', { class: 'quiet-note', text: calendar.url }),
      sourceStatusLine(calendar.id, 'calendars'),
      calendar.id === connectionId ? connectionRecovery(calendar.id, 'calendars') : null,
      el('div', { class: 'row-inline' }, [
        button('Edit', {
          class: 'btn quiet',
          onClick: () => openEditor(editor, status, (manifests) => calendarForm(calendar, {
            manifests,
            onSaved: () => rerender?.(),
            onCancel: () => editor.replaceChildren(),
          })),
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            await saveConfig({ calendars: (state.config.calendars || []).filter((c) => c.id !== calendar.id) });
            // The stored password goes with it, as a mail account's does.
            if (calendar.keyRef) await api.deleteSecret(calendar.keyRef).catch(() => {});
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'No calendar connected yet.' })));

  // The four named ways in. Each opens the editor on its guide; "Something
  // else" opens it on the first connector the registry lists, as "Add a
  // calendar" always did.
  wrap.appendChild(el('div', { class: 'preset-grid' }, CALENDAR_GUIDES.map((guide) => el('button', {
    type: 'button',
    class: 'preset',
    onclick: () => {
      const id = randomId('c');
      replace(helpSlot, [askClaude({ step: 'calendar', provider: guide.kind ? guide.id : null })]);
      openEditor(editor, status, (manifests, links) => calendarForm({
        id,
        enabled: true,
        label: '',
        /* The blank a new calendar opens on comes from the registry, not from
           the string 'ics': the first `calendars` connector is what the picker
           will be showing, and a literal here is a default that can disagree
           with the control under it. A guide names its kind on purpose. */
        kind: guide.kind || kindOptions(manifests, 'calendars')[0]?.value || '',
        url: '',
        user: '',
        keyRef: null,
      }, {
        manifests,
        guide,
        links,
        onSaved: () => { onDone?.(); rerender?.(); },
        onCancel: () => editor.replaceChildren(),
      }));
    },
  }, [
    el('span', { class: 'preset-label', text: guide.title }),
    el('span', { class: 'preset-note', text: guide.blurb }),
  ]))));
  wrap.appendChild(editor);
  wrap.appendChild(status.node);
  wrap.appendChild(helpSlot);
  if (connectionId && !calendars.some(calendar => calendar.id === connectionId)) wrap.prepend(missingConnection());
  return wrap;
}

/* ------------------------------------------------------------------ sources */

/**
 * The editor for `config.sources` — the third place config keeps a source, and
 * until now the one with no screen at all.
 *
 * There is nothing about any particular connector in this function, and that is
 * the whole point of it: the picker is the registry's `sources` connectors, the
 * body is whatever `fields[]` that connector declared, and the credential is the
 * one it asked for in the words it asked for it. A feed, a ticket queue and a
 * repository each get a form nobody wrote.
 *
 * Changing the kind rebuilds the body and DROPS the settings, which is right
 * rather than merely easy: `settings` is keyed by field name, and two connectors
 * that both happen to declare `url` mean entirely different addresses by it.
 * Carrying values across would hand a new connector a URL for somebody else's
 * service and call it configured.
 */
export function sourceForm(source, { manifests = [], onSaved, onCancel }) {
  const draft = { ...source };
  const status = statusLine();
  const options = kindOptions(manifests, 'sources');

  const typeSelect = select(options, { value: draft.type || options[0]?.value || '' });
  const labelInput = input({ value: draft.label || '', placeholder: 'Alder notices' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const body = el('div', { class: 'stack' });
  let controls = fieldControls(null);
  let credential = null;

  function drawBody() {
    const manifest = manifestFor(manifests, typeSelect.value);
    // The stored settings belong to the stored type. See the docstring.
    const values = manifest && manifest.type === source.type ? source.settings : {};
    controls = fieldControls(manifest, values);
    credential = credentialControl(manifest, {
      keyRef: draft.keyRef || `${typeSelect.value}.${draft.id}`,
      stored: state.secretRefs.includes(draft.keyRef),
    });
    body.replaceChildren(
      ...controls.nodes,
      credential ? credential.node : el('p', { class: 'quiet-note', text: 'This source needs no credential.' }),
    );
  }
  typeSelect.addEventListener('change', drawBody);
  drawBody();

  return el('div', { class: 'account-form' }, [
    field('What is it', typeSelect),
    field('Name it', labelInput, { hint: 'What the board calls anything that arrives from here.' }),
    body,
    el('div', { class: 'row-inline' }, [
      button('Save source', {
        class: 'btn solid',
        onClick: async () => {
          const type = typeSelect.value;
          if (!type) {
            status.bad('Pick what kind of source this is.');
            return;
          }
          const missing = controls.missing();
          if (missing.length) {
            const names = missing.map((f) => `“${f.label}”`).join(', ');
            status.bad(`${names} ${missing.length === 1 ? 'is' : 'are'} required.`);
            return;
          }
          status.working('Saving…');
          try {
            /* The keyRef is minted only when there is something to put behind
               it. core/config.mjs mints `${type}.${id}` on load for a source
               that has a type, and this is the same string — a keyRef written
               under one name and read under another is a password that is
               there and cannot be found. */
            if (credential?.input.value) {
              if (!draft.keyRef) draft.keyRef = `${type}.${draft.id}`;
              await api.setSecret(draft.keyRef, credential.input.value);
              credential.input.value = '';
            }
            const others = (state.config.sources || []).filter((s) => s.id !== draft.id);
            await saveConfig({
              sources: [...others, {
                ...draft,
                type,
                label: labelInput.value.trim(),
                settings: controls.read(),
              }],
            });
            status.good('Saved. Zelos reads it the next time it checks.');
            onSaved();
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Cancel', { class: 'btn quiet', onClick: onCancel }),
    ]),
    status.node,
  ]);
}

export function sourcesPanel({ rerender, connectionId = null } = {}) {
  const sources = state.config?.sources || [];
  const wrap = el('div', { class: 'panel panel-sources' });
  const editor = el('div', { class: 'editor' });
  const status = statusLine();

  wrap.appendChild(el('p', { class: 'panel-lede', text: 'Most people need nothing here. If you use any of these work tools, add them. Zelos only ever reads them — nothing is ever written back.' }));

  wrap.appendChild(el('div', { class: 'stack' }, sources.length
    ? sources.map((src) => el('div', connectionCardProps(src, connectionId), [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: src.label || src.id }),
        el('span', { class: 'mono account-host', text: src.type }),
        src.enabled === false ? el('span', { class: 'chip', text: 'off' }) : null,
      ]),
      sourceStatusLine(src.id, 'sources'),
      src.id === connectionId ? connectionRecovery(src.id, 'sources') : null,
      el('div', { class: 'row-inline' }, [
        button(src.enabled === false ? 'Enable' : 'Disable', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.sources || []).map((s) => (s.id === src.id ? { ...s, enabled: src.enabled === false } : s));
            await saveConfig({ sources: next });
            rerender?.();
          },
        }),
        button('Edit', {
          class: 'btn quiet',
          onClick: () => openEditor(editor, status, (manifests) => sourceForm(src, {
            manifests,
            onSaved: () => rerender?.(),
            onCancel: () => editor.replaceChildren(),
          })),
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            await saveConfig({ sources: (state.config.sources || []).filter((s) => s.id !== src.id) });
            if (src.keyRef) await api.deleteSecret(src.keyRef).catch(() => {});
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'Nothing else connected yet.' })));

  wrap.appendChild(el('div', { class: 'row-inline' }, button('Add a source', {
    class: 'btn solid',
    onClick: () => {
      const id = randomId('s');
      openEditor(editor, status, (manifests) => sourceForm({
        id,
        enabled: true,
        label: '',
        type: kindOptions(manifests, 'sources')[0]?.value || '',
        keyRef: null,
        settings: {},
      }, {
        manifests,
        onSaved: () => rerender?.(),
        onCancel: () => editor.replaceChildren(),
      }));
    },
  })));
  wrap.appendChild(editor);
  wrap.appendChild(status.node);
  if (connectionId && !sources.some(src => src.id === connectionId)) wrap.prepend(missingConnection());
  return wrap;
}

function connectionCardProps(connection, target) {
  const selected = connection.id === target;
  return {
    class: `account${selected ? ' is-connection-target' : ''}`,
    'data-connection-target': selected ? '' : null,
    tabindex: selected ? '-1' : null,
    'aria-label': selected ? `Connection: ${connection.label || connection.user || connection.id}` : null,
  };
}

function missingConnection() {
  return el('p', { class: 'quiet-note is-bad', 'data-connection-target': '', tabindex: '-1',
    text: 'This connection is no longer configured. Choose a connection below or add it again.' });
}

/* ----------------------------------------------------------------- sweeps */

/**
 * "6 am" for 6, "11 pm" for 23: what the two hour pickers say. Config stores
 * the 24-hour number (core/config.mjs validates 0–23, start before end), and
 * the 24-hour clock is exactly the thing the audit's reader did not know —
 * "23" was a number to them, not a time.
 */
export function hourLabel(h) {
  const n = Number(h);
  if (!Number.isInteger(n) || n < 0 || n > 23) return '';
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve} ${n < 12 ? 'am' : 'pm'}`;
}

/**
 * The choices each picker offers. The start can be any hour; the end stops at
 * 11 pm because config wants a number 0–23 and a start strictly before it — the
 * old number box accepted 24 and `|| 24`'d a blank, which validateConfig then
 * refused about a field the person had never seen.
 */
export const HOUR_CHOICES = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));
export const END_HOUR_CHOICES = HOUR_CHOICES.slice(1);

function sweepPanel() {
  const cfg = state.config?.sweep || { intervalMinutes: 30, activeHours: [6, 23], auto: true };
  const status = statusLine();

  const intervalInput = input({ type: 'number', value: String(cfg.intervalMinutes), min: '5', max: '1440' });
  const fromSelect = select(HOUR_CHOICES, { value: String(cfg.activeHours?.[0] ?? 6) });
  const toSelect = select(END_HOUR_CHOICES, { value: String(cfg.activeHours?.[1] ?? 23) });
  let auto = cfg.auto !== false;

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: 'When Zelos looks at your mail and calendar on its own. You can always press Check now as well.' }),
    checkbox('Check my mail automatically', { checked: auto, onChange: (v) => { auto = v; } }),
    el('div', { class: 'grid-2' }, [
      field('Check my mail every (minutes)', intervalInput),
      field('Between', el('div', { class: 'row-inline' }, [fromSelect, el('span', { text: 'and' }), toSelect])),
    ]),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          status.working('Saving…');
          try {
            await saveConfig({
              sweep: {
                intervalMinutes: Number(intervalInput.value) || 30,
                activeHours: [Number(fromSelect.value) || 0, Number(toSelect.value) || 23],
                auto,
              },
            });
            status.good('Saved. The new times apply from the next check.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
    fold('Advanced', [
      el('p', { class: 'quiet-note', text: 'A check fetches your email account, your calendars and anything under “Other things it can read”, and, only when something new arrived, asks the AI to re-read the board. Between those calls it still re-derives what is stale and what comes first, which costs nothing and contacts nobody.' }),
    ]),
  ]);
}

/* ---------------------------------------------------------------- privacy */

function privacyPanel() {
  const cfg = state.config?.privacy || { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 };
  const status = statusLine();
  let sendBodies = cfg.sendBodies !== false;
  const charsInput = input({ type: 'number', value: String(cfg.bodyChars), min: '200', max: '20000' });
  const maxInput = input({ type: 'number', value: String(cfg.maxItemsPerSweep), min: '10', max: '1000' });

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: 'Zelos only talks to the AI service you chose. It sends nothing to us and nothing to anyone else.' }),
    checkbox('Let the AI read the full text of your emails (recommended — it does a better job)', {
      checked: sendBodies,
      onChange: (v) => { sendBodies = v; },
      hint: 'Switched off, the AI sees only who wrote, the subject, and the first couple of lines. It will be worse at judging what matters, and it will say less about why.',
    }),
    fold('Advanced', [
      el('p', { class: 'quiet-note', text: 'There is no telemetry, analytics or remote font. Reading and AI use your configured services; update checks contact only the official GitHub release, without your data. These two numbers cap what each AI request carries.' }),
      el('div', { class: 'grid-2' }, [
        field('Characters of each email sent to the AI', charsInput),
        field('Most items per check', maxInput),
      ]),
    ]),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          status.working('Saving…');
          try {
            await saveConfig({
              privacy: {
                sendBodies,
                bodyChars: Number(charsInput.value) || 4000,
                maxItemsPerSweep: Number(maxInput.value) || 150,
              },
            });
            status.good('Saved.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
  ]);
}

/* ------------------------------------------------------------------- data */

/**
 * How to get to the folder once its path is on the clipboard, per platform.
 * The desktop shell has a button that opens it; a browser tab has only the
 * clipboard, so this is the one sentence that turns a path into a window.
 */
export function folderHint(platform = '') {
  const p = String(platform || '').toLowerCase();
  if (p.startsWith('win')) return 'In File Explorer, click the address bar, paste, and press Enter.';
  if (p.startsWith('linux')) return 'In your file manager, press Ctrl+L, paste, and press Enter.';
  return 'In Finder press ⌘⇧G, paste, and press Return.';
}

/**
 * Whether the page is inside the desktop shell with the one bridge that
 * reveals the folder (desktop/preload.js). The board has to keep working
 * when opened from `zelos` on the command line, where no preload runs.
 */
const canShowFolder = () => typeof window !== 'undefined' && typeof window.zelos?.showHome === 'function';

/** "312 MB" — how big the folder's database really is, in the unit that fits. */
function sizeOnDisk(bytes) {
  const v = Math.max(0, Number(bytes) || 0);
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (v >= 1024 * 1024) return `${Math.round(v / (1024 * 1024))} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} bytes`;
}

/** "2,143" — an exact count. The board's compact "2.1k" would be a guess here. */
const exactCount = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');

/** "2,143 emails", with the exact count above rather than plural()'s bare number. */
const counted = (n, word) => `${exactCount(n)} ${Number(n) === 1 ? word : `${word}s`}`;

/** "March 2026" from a stored date, or '' when there is nothing that old. */
function monthYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const name = monthName(Number(m[2]));
  return name ? `${name} ${m[1]}` : '';
}

/**
 * The stats block for the Your data panel: what the folder actually holds,
 * from GET /api/data's counts — filled in when the answer lands, and silent
 * on a build without the route. Every check stores mail forever, and "how big
 * has this gotten?" should not need Finder to answer.
 */
function dataStats() {
  const slot = el('div', { class: 'data-stats' });
  request('/api/data').then((d) => {
    const since = monthYear(d?.oldestMessageAt);
    const disk = sizeOnDisk((Number(d?.dbBytes) || 0) + (Number(d?.walBytes) || 0));
    const accounts = Array.isArray(d?.accounts) ? d.accounts : [];
    replace(slot, [
      el('p', { class: 'quiet-note', text: `${counted(d?.messageCount, 'email')}${since ? ` back to ${since}` : ''} · ${disk} on disk` }),
      el('p', { class: 'quiet-note', text: `${counted(d?.eventCount, 'appointment')} · ${counted(d?.itemCount, 'item')}` }),
      accounts.length > 1 ? el('dl', { class: 'facts' }, accounts.flatMap((a) => [
        el('dt', { text: String(a?.label || a?.id || 'account') }),
        el('dd', { text: counted(a?.messages, 'email') }),
      ])) : null,
    ]);
  }).catch(() => {
    /* An older build without the route, or a hiccup: the panel stands on its
       own, claiming nothing it cannot count. */
  });
  return slot;
}

function dataPanel() {
  const status = statusLine();
  const home = state.health?.home || '(unknown)';
  const platform = typeof window !== 'undefined' ? (window.zelos?.platform || window.navigator?.platform || '') : '';

  async function exportSnapshot() {
    status.working('Gathering…');
    try {
      const [board, config] = await Promise.all([api.state(), api.config()]);
      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        version: state.health?.version || null,
        config: config.config,
        board,
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `zelos-board-${Date.now()}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      status.good('Board snapshot saved. It contains no passwords and is not a full backup.');
    } catch (err) {
      status.bad(err.message);
    }
  }

  const copyPath = async () => {
    const ok = await copyText(home);
    if (ok) status.good(`Copied. ${folderHint(platform)}`);
    else status.bad('Could not reach the clipboard.');
  };

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: canUseBackups()
      ? 'Your board and saved history live on this computer. Create a backup before moving computers or making a big change.'
      : 'Your board and saved history live in one folder on this computer. For a complete data backup, quit Zelos first, then copy the whole folder to a private location. Passwords kept in your computer’s password storage may need to be entered again on a different computer.' }),
    dataStats(),
    backupPanel(),
    field('The Zelos folder', input({ value: home, readonly: true })),
    el('div', { class: 'row-inline' }, [
      canShowFolder()
        ? button('Show the Zelos folder', {
          class: 'btn solid',
          onClick: async () => {
            const shown = await window.zelos.showHome().catch(() => false);
            if (!shown) { status.bad('Could not open the folder. Copy the path instead:'); await copyPath(); }
          },
        })
        : button('Copy the folder path', { class: 'btn solid', onClick: copyPath }),
      button('Save board snapshot', { class: 'btn quiet', onClick: exportSnapshot }),
    ]),
    el('p', { class: 'quiet-note', text: 'The snapshot includes the current board and settings, without passwords. It does not include your full mail archive, captures or complete item history. Use a backup to restore your data.' }),
    canShowFolder() ? null : el('p', { class: 'quiet-note', text: folderHint(platform) }),
    section('Erasing everything', {}, [
      el('p', { class: 'quiet-note', text: 'To erase everything: quit Zelos, then drag this folder to the Trash and empty the Trash.' }),
      el('p', { class: 'quiet-note', text: plainSecretNotes(state.health?.backend?.name).data }),
      fold('For experts', [
        el('p', { class: 'quiet-note', text: 'Zelos deliberately has no route that wipes your data — a local server that can destroy the database on request is a local server a stray web page can point at. Done by hand, with the app closed, it is one command:' }),
        el('pre', { class: 'code' }, el('code', { text: `rm -rf "${home}"` })),
        el('p', { class: 'quiet-note', text: secretStoreNotes(state.health?.backend?.name).data }),
      ]),
    ]),
    status.node,
  ]);
}

/* ------------------------------------------------------------------ about */

function aboutPanel() {
  const backend = state.health?.backend || { name: 'unknown', writable: false, note: '' };
  // The day's AI usage, moved here from the header. A count of what went to
  // the AI, never a price: Zelos has no idea what anyone is paying per token.
  // The day key is load-bearing: without it, a counter written yesterday reads
  // as today's spend on a machine that has not checked yet today.
  const tokens = state.board?.tokens;
  const todayKey = nowMark().key;
  const usage = tokenLine(tokens, todayKey);
  // `modelRuns` counts the checks that actually asked the AI to think
  // (core/sweep.mjs recordTokens). A question typed into Ask moves the token
  // totals and deliberately not this count — it is not a check that happened.
  const asked = usage && tokens?.day === todayKey ? Number(tokens.modelRuns) || 0 : 0;
  const lifetime = tokens?.lifetime && typeof tokens.lifetime === 'object' ? tokens.lifetime : null;
  const lifetimeUsage = tokenLine(lifetime);
  const lifetimeAsked = lifetimeUsage ? Number(lifetime.modelRuns) || 0 : 0;
  return el('div', { class: 'panel panel-about' }, [
    el('dl', { class: 'facts' }, [
      el('dt', { text: 'Version' }), el('dd', { class: 'mono', text: state.health?.version || '—' }),
      el('dt', { text: 'Folder' }), el('dd', { class: 'mono', text: state.health?.home || '—' }),
      el('dt', { text: 'AI' }),
      el('dd', {
        // `label` carries a default, so it is not evidence that anything works.
        text: state.health?.model?.configured
          ? `${state.health.model.label}${state.health.model.local ? ' · on this computer' : ''}`
          : 'none chosen yet',
      }),
      el('dt', { text: 'AI usage today' }),
      el('dd', { text: usage
        ? `${usage}${asked ? ` · asked to think ${plural(asked, 'time')}` : ''}. What that costs depends on your AI service’s prices; Zelos does not see them.`
        : 'Nothing sent to the AI yet today.' }),
      // The running total is not the day's, so no day can stale it.
      lifetimeUsage ? el('dt', { text: 'Since the start' }) : null,
      lifetimeUsage ? el('dd', { text: `${lifetimeUsage}${lifetimeAsked ? ` · asked to think ${plural(lifetimeAsked, 'time')}` : ''}.` }) : null,
    ]),
    el('p', { class: 'panel-lede', text: plainSecretNotes(backend.name).about }),
    updatesPanel(),
    fold('Security details', [
      el('dl', { class: 'facts' }, [
        el('dt', { text: 'Secret store' }), el('dd', { class: 'mono', text: backend.name }),
        el('dt', { text: 'Model endpoint' }), el('dd', { class: 'mono', text: state.config?.model?.baseUrl || '—' }),
      ]),
      // The store's own note, with its shouting taken out: "does NOT protect"
      // in capitals reads as "you are not protected" to the person it was
      // meant to reassure, and the sentence is just as true in lower case.
      backend.note ? section('What the secret store protects', {}, el('p', { class: 'panel-lede', text: String(backend.note).replace(/\bNOT\b/g, 'not') })) : null,
      section('Where Zelos stands', {}, [
        el('ul', { class: 'plain-list' }, [
          el('li', { text: 'The server binds 127.0.0.1 and nothing else. Every API call carries a session token minted at launch; no CORS header is ever sent, so a page in another tab cannot read one. The one exception is /api/mcp, the read-only channel an AI client uses: it is off until you switch it on under Share with another AI, and it carries the separate AI token you mint there rather than the session token — that one is meant to outlive a restart, and it lasts until you turn sharing off or revoke it.' }),
          el('li', { text: 'Reading and AI checks contact the services you configured. Pressing Check for updates also contacts the official Zelos releases on GitHub; it sends no account content or credentials.' }),
          el('li', { text: 'Mail is untrusted input, and so is anything the model writes after reading it. Zelos never executes, shells out to, or navigates to anything derived from either. It renders them, and you click.' }),
          el('li', { text: 'Drafts are drafts. Zelos has no send path at all — not a disabled button, no code.' }),
          el('li', { text: 'Prompt-injection defences here are mitigation, not proof. The guarantee is the one above: nothing acts on model output but you.' }),
        ]),
      ]),
    ]),
    section('Start over', {}, [
      el('p', { class: 'quiet-note', text: 'Run the first-time setup again. Nothing is deleted; it just walks you back through the choices.' }),
      el('div', { class: 'row-inline' }, button('Run setup again', {
        class: 'btn quiet',
        onClick: () => {
          markOnboarded(false);
          window.location.hash = '#/welcome';
        },
      })),
    ]),
  ]);
}

/* --------------------------------------------------------- appearance */

/**
 * Zelos is black, always. The only appearance choice is the accent — one hex
 * that the stylesheet derives everything else from, including the light behind
 * the glass. A handful of presets for people who want to be done in one click,
 * plus a real colour input for people who have a hex in mind.
 */
const ACCENT_PRESETS = [
  { hex: '#5b8cff', name: 'Blue' },
  { hex: '#38bdf8', name: 'Ice' },
  { hex: '#34d399', name: 'Jade' },
  { hex: '#c084fc', name: 'Violet' },
  { hex: '#f472b6', name: 'Rose' },
  { hex: '#fb923c', name: 'Ember' },
  { hex: '#e2b714', name: 'Gold' },
  { hex: '#94a3b8', name: 'Steel' },
];

function appearancePanel() {
  const accent = currentAccent();

  const swatches = el('div', { class: 'accent-row', role: 'group', 'aria-label': 'Accent colour' },
    ACCENT_PRESETS.map((p) => {
      const chosen = p.hex === accent;
      const b = el('button', {
        type: 'button',
        class: `accent-swatch${chosen ? ' is-chosen' : ''}`,
        title: p.name,
        'aria-label': `${p.name} accent`,
        'aria-pressed': chosen ? 'true' : 'false',
        onclick: () => { setAccent(p.hex); rerenderAccent(); },
      });
      // A hex from our own closed list, set as a property rather than
      // interpolated into a style string.
      b.style.setProperty('--swatch', p.hex);
      return b;
    }));

  const custom = el('input', {
    type: 'color',
    class: 'accent-input',
    id: 'accent-custom',
    value: accent,
    oninput: (e) => { applyAccent(e.target.value); },      // live, every drag
    onchange: (e) => { setAccent(e.target.value); rerenderAccent(); }, // persist on release
  });

  function rerenderAccent() {
    for (const b of swatches.querySelectorAll('.accent-swatch')) {
      const on = b.title.toLowerCase() === (ACCENT_PRESETS.find((p) => p.hex === currentAccent())?.name || '').toLowerCase();
      b.classList.toggle('is-chosen', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    custom.value = currentAccent();
  }

  return el('div', { class: 'panel accent-choice' }, [
    el('p', { class: 'panel-lede', text:
      'Zelos is black. The accent is the one colour on screen — it marks the thing that needs you, and nothing else.' }),
    swatches,
    el('div', { class: 'accent-custom-row' }, [
      el('label', { class: 'field-label', for: 'accent-custom', text: 'Or pick your own' }),
      custom,
      el('button', {
        type: 'button',
        class: 'btn quiet',
        text: 'Reset to blue',
        onclick: () => { setAccent(DEFAULT_ACCENT); rerenderAccent(); },
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------------- render */

/**
 * A tab that announces "tab, selected" while pointing at nothing is worse than
 * a plain button, and that is what this strip was: `role="tablist"`,
 * `role="tab"` and `aria-selected` were all set, while the panel had no
 * `role="tabpanel"`, no `aria-labelledby`, and the tabs had no `id` and no
 * `aria-controls`. A screen-reader user was told there were eight tabs and
 * given no way to find out what any of them controlled.
 *
 * Finished here rather than dropped, because ui/app.js's `refocusSelectedTab()`
 * now finds the pressed tab again after the sub-route rebuild by selecting on
 * `[role="tab"][aria-selected="true"]` — the roles are load-bearing.
 *
 * Two things the plain APG pattern has to be adapted for:
 *
 *  - Only ONE panel is ever in the document; changing tabs re-renders the view.
 *    So `aria-controls` is set on the selected tab only. Pointing the other
 *    seven at ids that do not exist is a dangling reference, which several
 *    screen readers report as an empty relationship rather than as no
 *    relationship — worse than the omission it would be fixing.
 *  - The ids are fixed strings, not `nextId()` counters. They have to survive
 *    every rebuild, and a counter that ticks on each render would leave
 *    `aria-labelledby` pointing at the id the tab had one paint ago.
 */
const tabId = (id) => `settings-tab-${id}`;
const panelId = (id) => `settings-panel-${id}`;

export function renderSettings(ctx) {
  // Only a sub-route that names a real panel, or the strip highlights
  // nothing and the ids below point at elements that do not exist — the
  // dangling-relationship failure the comment above is about.
  const panel = PANELS.some((p) => p.id === ctx.sub) ? ctx.sub : DEFAULT_PANEL;
  const rerender = ctx.rerender;

  // Arrow keys move between tabs, the way a tablist is expected to. Activation
  // follows selection because a panel here costs one render, and the roving
  // tabindex below means this only ever fires on the selected tab.
  const onTabKey = (event) => {
    const here = PANELS.findIndex((p) => p.id === panel);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (here + 1) % PANELS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (here - 1 + PANELS.length) % PANELS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = PANELS.length - 1;
    if (next < 0 || here < 0) return;
    event.preventDefault();
    ctx.navigate(`#/settings/${PANELS[next].id}`);
  };

  const tabs = el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Settings sections' },
    PANELS.map((p) => {
      const selected = p.id === panel;
      return el('button', {
        type: 'button',
        class: 'subtab',
        id: tabId(p.id),
        role: 'tab',
        'aria-selected': selected ? 'true' : 'false',
        // Only the live panel exists to be controlled; see above.
        'aria-controls': selected ? panelId(p.id) : null,
        // Roving tabindex: one stop for the whole strip, arrows inside it.
        tabindex: selected ? '0' : '-1',
        onclick: () => ctx.navigate(`#/settings/${p.id}`),
        onkeydown: onTabKey,
        text: p.label,
      });
    }));

  let body;
  if (panel === 'you') body = youPanel();
  else if (panel === 'mail') body = mailPanel({ rerender, connectionId: ctx.connectionId });
  else if (panel === 'calendars') body = calendarPanel({ rerender, connectionId: ctx.connectionId });
  else if (panel === 'sources') body = sourcesPanel({ rerender, connectionId: ctx.connectionId });
  else if (panel === 'sweep') body = sweepPanel();
  else if (panel === 'privacy') body = privacyPanel();
  else if (panel === 'ai') {
    // The audit's reader opened this tab looking for the place to switch the
    // AI on, because the board kept saying "no model yet". One sentence,
    // first, before the panel explains what it hands over.
    body = el('div', { class: 'panel' }, [
      el('p', { class: 'panel-lede', text: 'This is NOT where you choose the AI that reads your mail — that is under AI. Leave this off unless you know what it is.' }),
      aiAccessPanel(),
    ]);
  } else if (panel === 'data') body = dataPanel();
  else if (panel === 'about') body = aboutPanel();
  else if (panel === 'appearance') body = appearancePanel();
  else body = modelPanel({});

  // The other half of the relationship the tabs now name. `tabindex="-1"` is
  // not for keyboard order — every panel here has focusable content of its own —
  // it is so the panel can be given focus programmatically without becoming one
  // more tab stop after the strip.
  body.setAttribute('id', panelId(panel));
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', tabId(panel));
  body.setAttribute('tabindex', '-1');

  const errors = state.configErrors || [];

  // The colour picker is a tab now — the last one — rather than the first
  // thing Settings shows. People open Settings to find their email.
  return el('div', { class: 'view view-settings' }, [
    el('div', { class: 'settings-head' }, [
      el('h1', { class: 'view-title', text: 'Settings' }),
    ]),
    meander(),
    setupStatus(ctx.navigate),
    tabs,
    errors.length
      ? el('div', { class: 'banner banner-warn', role: 'status' }, [
        el('h3', { class: 'banner-title', text: 'Still incomplete' }),
        el('ul', { class: 'banner-list' }, errors.map((e) => el('li', { text: `${e.path}: ${e.message}` }))),
      ])
      : null,
    body,
  ]);
}
