/**
 * ui/views/ai-access.js — the panel where someone hands their mail to an AI.
 *
 * This is the most exposing screen in the app, so it is deliberately the least
 * convenient one. Four decisions drive everything below:
 *
 *  1. **It explains before it offers.** Every scope carries a sentence saying
 *     what that scope actually hands over, written as a fact rather than as
 *     reassurance. Someone who reads this page slowly should be able to say out
 *     loud what they allowed. If the copy here ever reads like marketing, it is
 *     wrong.
 *  2. **`mail.bodies` is not a checkbox.** It is the one choice that puts the
 *     full text of everything anyone has written to you on the other end of a
 *     socket, so it is a button that asks and a second button that confirms.
 *     Everything else on this page is a tick.
 *  3. **The server is the only source of truth.** All four routes —
 *     `GET/PUT /api/ai`, `POST /api/ai/tokens`, `DELETE /api/ai/tokens/:id` —
 *     answer with the same payload, so a change is applied by keeping the
 *     response, never by patching a local copy that could drift from what is on
 *     disk. In particular `effectiveScopes` is read rather than recomputed:
 *     `mail.bodies` grants mail headers, and the panel must show that without
 *     pretending the user ticked the headers box.
 *  4. **It degrades honestly.** If this build has no `/api/ai`, the panel says
 *     so in those words and still explains what each scope would hand over. It
 *     never renders a screen of controls that quietly do nothing.
 *
 * A note on state. The settings view re-renders wholesale whenever anything
 * bumps `state.rev` (see ui/app.js), which would rebuild this panel underneath
 * the user. The few things that must survive that — the fetched payload, a
 * minted token that will never be shown again, an open confirmation — live at
 * module scope rather than in the closure.
 */

import { el, button, section, copyText, focusQuietly } from '../lib/dom.js';
// `request` as well as `api`: two of the calls here take a query string or a
// body that the shared endpoint list has no reason to know about.
import { api, isMissingRoute, request } from '../lib/api.js';
// Nothing is read from the store: `/api/ai` is the whole of this panel's truth,
// including the install paths it prints, so there is no second copy to drift.
// A cycle: settings.js imports this panel, this panel imports its form helpers.
// Both sides are `export function` declarations, which are initialised before
// either module body runs, so nothing here is touched before it exists.
import { field, fold, input, statusLine } from './settings.js';
import { formatDay, formatTime, humanDelta } from '../lib/time.js';
import { plural } from '../lib/format.js';

/* ------------------------------------------------------------------ scopes */

/**
 * What each scope hands over, in this panel's words.
 *
 * `GET /api/ai` sends a `scopeInfo` entry for every scope — `{id, label,
 * summary, tools, implies, sensitive}` — and that is what drives the list, so a
 * scope added to the closed set later still renders with the server's own
 * description. These longer sentences replace `summary` where they exist,
 * because the short form is accurate but does not make anyone stop, and
 * stopping is the entire job of this list.
 */
const SCOPE_COPY = {
  board: {
    what: 'Every item Zelos has triaged: the headline it wrote, the reason it gave, the bucket, the due date, and the person the item is about — with their address.',
  },
  calendar: {
    what: 'Events in whatever window is asked for: title, start and end, location, and the full attendee list, everyone’s email address included.',
  },
  'mail.metadata': {
    what: 'Who wrote to you, what the subject line said, when it arrived, and the opening lines Zelos keeps as a snippet. The body is withheld — but search runs over the indexed body, so a hit still reveals that a word appears somewhere in a message.',
  },
  'mail.bodies': {
    exposing: true,
    what: 'The entire text of the messages Zelos has indexed. Not a summary and not an extract — the message, as it was written. Zelos cannot tell which of those were written to you in confidence, so it does not try to hold any of them back.',
    also: 'This grants mail headers too, whether or not that box is ticked: a body is returned with the message it belongs to.',
  },
  drafts: {
    what: 'The replies Zelos has drafted on your behalf, in full — including the ones you have not read yet and the ones you decided against.',
  },
  people: {
    what: 'The addresses in your mail, how often each appears, and when you last heard from them. That is a map of who you talk to, which is worth reading on its own, without a single message attached.',
  },
};

/** How each scope is named inside a running sentence. */
const SHORT = {
  board: 'your board',
  calendar: 'your calendar',
  'mail.metadata': 'mail headers',
  'mail.bodies': 'full message text',
  drafts: 'your drafts',
  people: 'your contacts',
};

/**
 * The scope list this panel falls back to when there is no server to ask — the
 * closed set from SPEC-v2 §1, so the "not in this build" screen can still teach
 * what the choices would be.
 */
const FALLBACK_SCOPE_INFO = [
  { id: 'board', label: 'Board', tools: ['zelos_board', 'zelos_item'] },
  { id: 'calendar', label: 'Calendar', tools: ['zelos_calendar'] },
  { id: 'mail.metadata', label: 'Mail, without the mail', tools: ['zelos_search', 'zelos_thread'] },
  { id: 'mail.bodies', label: 'Mail, in full', tools: [], implies: ['mail.metadata'], sensitive: true },
  { id: 'drafts', label: 'Drafts', tools: ['zelos_drafts'] },
  { id: 'people', label: 'People', tools: ['zelos_people'] },
];

/* ------------------------------------------- state that outlives a rebuild */

/** The last payload from any of the four routes. */
let data = null;
/** `'boot' | 'ready' | 'missing' | 'error'`. */
let phase = 'boot';
let loadError = '';
/** A minted token, held only until the user says they have copied it. */
let revealed = null;
/**
 * What the reader has typed into 'Check a token', kept across rebuilds.
 *
 * The panel is rebuilt wholesale by anything that bumps the settings view, and
 * the field used to be re-seeded with the just-minted token every time — so
 * someone who pasted a DIFFERENT token, pressed Test, and pressed it again was
 * testing the minted one while the box in front of them appeared to say
 * otherwise. Null means "untouched", which is not the same as an emptied field
 * and must not be: an emptied field stays empty.
 */
let tokenDraft = null;
/** `{kind:'bodies'|'revoke', id}` — an armed confirmation. */
let pending = null;
/** `{text, tone}` — painted into the live region once it is in the document. */
let announcement = null;
/** How many access-log rows have been asked for; 0 means the server's default. */
let logWindow = 0;
/** The last connection test's payload, so it survives a rebuild of the panel. */
let probe = null;

let uid = 0;
const nextId = (prefix) => `${prefix}-ai-${(uid += 1)}`;

/* ---------------------------------------------------------------- reading */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The payload, with every field this panel reads given a safe shape. */
function view() {
  const raw = isObject(data) ? data : {};
  const info = Array.isArray(raw.scopeInfo) && raw.scopeInfo.length ? raw.scopeInfo : FALLBACK_SCOPE_INFO;
  const scopes = isObject(raw.scopes) ? raw.scopes : {};
  const effective = isObject(raw.effectiveScopes) ? raw.effectiveScopes : scopes;
  const rows = Number(raw.maxRows);
  return {
    enabled: raw.enabled === true,
    scopes,
    effective,
    maxRows: Number.isFinite(rows) && rows > 0 ? rows : 50,
    tokens: Array.isArray(raw.tokens) ? raw.tokens.filter(isObject) : [],
    access: Array.isArray(raw.access) ? raw.access.filter(isObject) : [],
    accessMore: raw.accessMore === true,
    accessMax: Number.isFinite(Number(raw.accessMax)) ? Number(raw.accessMax) : 500,
    client: isObject(raw.client) ? raw.client : {},
    scopeInfo: info.filter(isObject).map((s) => {
      const copy = SCOPE_COPY[s.id] || {};
      const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      return {
        id: String(s.id || ''),
        label: String(s.label || s.id || ''),
        tools: strings(s.tools),
        implies: strings(s.implies),
        // `sensitive` is the server's word for it. The local copy names the same
        // scope independently, so a build that dropped the flag still cannot
        // turn mail.bodies into an ordinary tick.
        exposing: s.sensitive === true || copy.exposing === true,
        what: copy.what || (typeof s.summary === 'string' ? s.summary : ''),
        also: copy.also || '',
      };
    }).filter((s) => s.id),
  };
}

/** "a, b and c" — a sentence, not a list. */
function listWords(words) {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function nameOf(scope) {
  return SHORT[scope.id] || scope.label.toLowerCase();
}

/**
 * One sentence describing what is exposed *right now*, derived from the payload
 * rather than written down beside it — a summary that can drift from the
 * switches it summarises is worse than no summary at all.
 */
function exposureLine(v) {
  const on = v.scopeInfo.filter((s) => v.effective[s.id]).map(nameOf);
  if (!v.enabled) {
    return on.length
      // "boxes", and "does" for one: plural() adds a bare "s", which made
      // "the 2 boxs" (QA, 2026-10-10, TT-3466).
      ? `Nothing is shared. The switch is off, so the ${plural(on.length, 'box', 'boxes')} ticked below ${on.length === 1 ? 'does' : 'do'} nothing until you switch it on.`
      : 'Nothing is shared. The switch is off and no box is ticked.';
  }
  if (!on.length) {
    return 'The switch is on, but no box is ticked, so the other program gets nothing when it asks. That works — it is just not useful.';
  }
  if (!v.tokens.length) {
    return `${capitalise(listWords(on))} could be read, but no key has been created yet. (For experts: a program that starts Zelos itself needs no key, and can already read them.)`;
  }
  return `${capitalise(listWords(on))} can be read with ${plural(v.tokens.length, 'key')}, up to ${plural(v.maxRows, 'row')} at a time, until you switch this off.`;
}

/* ---------------------------------------------------------- config blocks */

/** What the HTTP block says where a token would go, when there is none to put. */
const TOKEN_PLACEHOLDER = 'PASTE-THE-TOKEN-YOU-MINTED';

/**
 * What goes in an AI client's own config file. The stdio form is what a desktop
 * client spawns; the HTTP form is for clients that would rather post. Both are
 * built from the paths the server reported, so what is on screen is where this
 * copy of Zelos actually lives.
 */
export function stdioBlock(client) {
  const server = {
    command: typeof client.command === 'string' && client.command ? client.command : 'npx',
    args: Array.isArray(client.args) && client.args.length ? client.args : ['-y', 'zelos-app', 'mcp'],
  };
  // The desktop app's block carries ELECTRON_RUN_AS_NODE: it starts the app's
  // own binary as plain Node (QA, 2026-10-10, TT-3507).
  const env = { ...(client.env && typeof client.env === 'object' ? client.env : {}) };
  if (client.home) env.ZELOS_HOME = client.home;
  if (Object.keys(env).length) server.env = env;
  return JSON.stringify({ mcpServers: { zelos: server } }, null, 2);
}

/** Said in place of "Ready to paste" when macOS is running Zelos from somewhere
 *  that stops existing once it quits — a translocated copy or a read-only disk
 *  image — so the command in the block would too (QA, 2026-10-10, TT-3507). */
const MOVE_FIRST_TITLE = 'Move Zelos to Applications first';
const MOVE_FIRST_NOTE = 'macOS is running this copy of Zelos from a temporary place or from the disk image, and that path stops existing when Zelos quits, so there is nothing here to copy yet. Move Zelos to your Applications folder, open it from there, and the settings to copy will be here.';

/**
 * `token` is the value that was just minted, when there is one. Assembling the
 * block by hand — copy this, then go back and paste that into the middle of it —
 * is where a setup goes wrong, and it goes wrong silently: a client with a
 * placeholder where its credential should be reports "unauthorized", which
 * reads like the token is bad rather than absent. So the one moment the value
 * exists, it is written into the block the person is about to copy.
 */
function httpBlock(client, token = '') {
  return JSON.stringify({
    mcpServers: {
      zelos: {
        type: 'http',
        url: client.httpUrl || `${window.location.origin}/api/mcp`,
        headers: { Authorization: `Bearer ${token || TOKEN_PLACEHOLDER}` },
      },
    },
  }, null, 2);
}

/** A code block with a copy button beside its heading. */
function codeCard(title, text, note, onCopied) {
  return el('div', { class: 'ai-code' }, [
    el('div', { class: 'ai-code-head' }, [
      el('span', { class: 'ai-code-title', text: title }),
      button('Copy', {
        class: 'btn quiet',
        onClick: async () => {
          const ok = await copyText(text);
          onCopied(
            ok ? `${title} block copied.` : 'Could not reach the clipboard — select the block and copy it by hand.',
            ok ? 'good' : 'bad',
          );
        },
      }),
    ]),
    note ? el('p', { class: 'field-hint', text: note }) : null,
    /* Wider than a phone, and nothing inside takes focus: without a tab stop
       a browser that does not focus scroll boxes itself leaves the end of
       each line out of keyboard reach (QA, 2026-10-10, TT-3473). */
    el('pre', { class: 'code', tabindex: '0' }, el('code', { text })),
  ]);
}

/**
 * The block a client that spawns Zelos needs — or, while macOS is running Zelos
 * from a path that will not outlive it, the reason there is no block yet. Not a
 * block with a warning beside it: a pasted command that stops working when
 * Zelos quits fails later, in the other program, where nobody connects the two.
 */
export function spawnCard(client, title, note, onCopied) {
  if (!client?.moveFirst) return codeCard(title, stdioBlock(client), note, onCopied);
  return el('div', { class: 'ai-code' }, [
    el('div', { class: 'ai-code-head' }, [el('span', { class: 'ai-code-title', text: MOVE_FIRST_TITLE })]),
    el('p', { class: 'field-hint', text: MOVE_FIRST_NOTE }),
  ]);
}

/* --------------------------------------------------------------- one scope */

/**
 * A scope row. `mail.bodies` gets a different one on purpose: an accent edge, a
 * marker, and a button instead of a tick, so that turning it on is an act
 * rather than a stray click on the way past.
 */
function scopeRow(scope, { ticked, effective, grantedBy, readOnly, armed, onToggle, onArm, onCancel }) {
  // A span, not a div: for the ordinary scopes this is wrapped in a <label>,
  // whose content model is phrasing content only.
  const head = el('span', { class: 'scope-head' }, [
    el('span', { class: 'scope-label', text: scope.label }),
    el('code', { class: 'mono scope-name', text: scope.id }),
    scope.exposing ? el('span', { class: 'scope-mark', text: 'The most exposing choice' }) : null,
  ]);

  const body = [
    el('p', { class: 'scope-what', text: scope.what }),
    scope.also ? el('p', { class: 'scope-also', text: scope.also }) : null,
    // Granted, but not by this box. `mail.bodies` carries mail headers with it,
    // and saying nothing here would let someone believe they had closed a door
    // that is still open. The grant is read off the server's `implies`, so it
    // stays true if the closed set ever grows another one.
    grantedBy
      ? el('p', { class: 'scope-granted', text: `On right now because ${grantedBy} is on. Unticking this box changes nothing while that stays on.` })
      : null,
    scope.tools.length
      ? el('p', { class: 'scope-tools' }, [
        el('span', { class: 'scope-tools-label', text: 'Tools' }),
        ...scope.tools.map((t) => el('code', { class: 'mono scope-tool', text: t })),
      ])
      : null,
  ];

  /* --- the ordinary scopes: a tick, a name, a fact ---------------------- */
  if (!scope.exposing) {
    const id = nextId('scope');
    const box = el('input', { class: 'checkbox', type: 'checkbox', id });
    box.checked = ticked;
    if (readOnly) box.disabled = true;
    else box.addEventListener('change', () => onToggle(box.checked));
    return el('div', { class: `scope${effective ? ' is-on' : ''}` }, [
      el('div', { class: 'scope-toggle' }, [
        box,
        el('label', { class: 'scope-toggle-label', for: id }, head),
      ]),
      ...body,
    ]);
  }

  /* --- mail.bodies ------------------------------------------------------ */
  const stateChip = el('span', {
    class: `scope-state${ticked ? ' is-on' : ''}`,
    text: ticked ? 'on — the full text of your mail is being shared' : 'off — the full text is kept back',
  });

  let action = null;
  if (readOnly) {
    action = null;
  } else if (armed) {
    action = el('div', { class: 'scope-confirm', role: 'group', 'aria-label': 'Confirm full message text' }, [
      el('p', { class: 'scope-confirm-q', text: 'Hand over the full text of your mail?' }),
      el('p', { class: 'scope-confirm-what', text: 'From the moment you confirm, any program you have let in can read the whole of every message Zelos has stored, as often as it likes, until you switch this off. It shares the mail headers too.' }),
      el('div', { class: 'row-inline' }, [
        button('Yes — hand over full message text', {
          class: 'btn solid',
          'data-confirm': 'true',
          onClick: () => onToggle(true),
        }),
        button('Cancel', { class: 'btn quiet', onClick: onCancel }),
      ]),
    ]);
  } else {
    action = el('div', { class: 'row-inline' }, button(
      ticked ? 'Stop handing over message text' : 'Turn on full message text…',
      { class: ticked ? 'btn quiet' : 'btn', onClick: () => (ticked ? onToggle(false) : onArm()) },
    ));
  }

  return el('div', { class: `scope scope-exposing${ticked ? ' is-on' : ''}` }, [
    head,
    stateChip,
    ...body,
    action,
  ]);
}

/* ------------------------------------------------------------- token rows */

function tokenRow(token, { armed, onArm, onCancel, onRevoke }) {
  const label = typeof token.label === 'string' && token.label ? token.label : 'unnamed key';
  const created = token.createdAt
    ? `created ${formatDay(token.createdAt)}${formatTime(token.createdAt) ? ` at ${formatTime(token.createdAt)}` : ''}`
    : 'created at an unrecorded time';
  const used = token.lastUsedAt ? `last used ${humanDelta(token.lastUsedAt)}` : 'never used';

  return el('div', { class: 'ai-token' }, [
    el('div', { class: 'ai-token-head' }, [
      el('span', { class: 'ai-token-label', text: label }),
      el('code', { class: 'mono ai-token-id', text: String(token.id || '—') }),
    ]),
    el('p', { class: 'ai-token-meta', text: `${created} · ${used}` }),
    armed
      ? el('div', { class: 'ai-token-confirm', role: 'group', 'aria-label': `Confirm revoking ${label}` }, [
        el('p', { class: 'ai-token-confirm-q', text: `Revoke ${label}? The program using it stops working the moment you do, and the key cannot be brought back.` }),
        el('div', { class: 'row-inline' }, [
          button('Revoke it', { class: 'btn solid', 'data-confirm': 'true', onClick: onRevoke }),
          button('Keep it', { class: 'btn quiet', onClick: onCancel }),
        ]),
      ])
      : el('div', { class: 'row-inline' }, button('Revoke', { class: 'btn quiet', onClick: onArm })),
  ]);
}

/* --------------------------------------------------------------- log rows */

/**
 * Who made the call, in the words the person reading this chose.
 *
 * The log stores a token id, because that is what identifies a token for ever.
 * `t_9f3a1c` is not an answer to "what did my AI read?", so the server resolves
 * it back to the label, and a row whose token has since been revoked says so —
 * "a client you have since cut off read this" is the most interesting line on
 * the screen, and hiding it behind a blank would be the wrong instinct.
 */
function callerOf(entry) {
  const label = typeof entry.label === 'string' && entry.label ? entry.label : '';
  const client = typeof entry.client === 'string' ? entry.client : '';
  if (entry.tokenRevoked === true) return `${label || client || 'a client'} · revoked since`;
  return label || client;
}

function logRow(entry) {
  const refused = entry.ok === false;
  const rows = Number(entry.rows);
  const when = entry.at
    ? `${humanDelta(entry.at)}${formatTime(entry.at) ? ` · ${formatTime(entry.at)}` : ''}`
    : 'time not recorded';
  const who = callerOf(entry);

  return el('div', { class: `ai-log-row${refused ? ' is-refused' : ''}` }, [
    el('code', { class: 'mono ai-log-tool', text: String(entry.tool || 'unknown tool') }),
    el('span', { class: 'ai-log-scope', text: String(entry.scope || 'no scope') }),
    el('span', {
      class: 'ai-log-rows mono',
      text: refused ? 'refused' : plural(Number.isFinite(rows) ? rows : 0, 'row'),
    }),
    who ? el('span', { class: 'ai-log-label', text: who }) : null,
    // Last, and pushed to the far edge, so the times line up down the column.
    el('span', { class: 'ai-log-when', text: when }),
  ]);
}

/* -------------------------------------------------------------- the panel */

/**
 * The AI access panel.
 *
 * It takes no `rerender` seam, unlike the other settings panels: it does not
 * write through `saveConfig`, so nothing it does bumps `state.rev`, and every
 * one of its routes hands back the whole state. It repaints itself, and the
 * rest of Settings has nothing to redraw when it does.
 */
export function aiAccessPanel() {
  const wrap = el('div', { class: 'panel panel-ai' });
  const live = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const mintStatus = statusLine();
  const testStatus = statusLine();
  let busy = false;

  /** Say something in the live region. Set before a request, painted after. */
  function say(text, tone = 'good') {
    announcement = text ? { text, tone } : null;
  }

  /**
   * A live region only announces when its content *changes* after it is in the
   * document — text baked in at build time is silent. Filling it one frame
   * later is what makes a rebuilt panel still speak.
   */
  function paintLive() {
    if (!announcement) {
      live.textContent = '';
      live.className = 'status';
      return;
    }
    const { text, tone } = announcement;
    live.className = `status is-${tone}`;
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function paint() {
    wrap.replaceChildren(...build());
    paintLive();
    if (pending) {
      const target = wrap.querySelector('[data-confirm]');
      if (target) focusQuietly(target);
    }
  }

  /* ------------------------------------------------------------ requests */

  /**
   * Every route answers with the whole state, so applying a change is keeping
   * the response. Nothing here patches a local copy — a panel that guessed the
   * outcome of a write is a panel that can show a scope as open when the server
   * refused it.
   */
  async function run(work, { message = null, onDone = null } = {}) {
    if (busy) return;
    busy = true;
    try {
      const res = await work();
      data = res;
      phase = 'ready';
      if (message) say(message);
      onDone?.(res);
    } catch (err) {
      if (isMissingRoute(err) && phase === 'boot') {
        phase = 'missing';
      } else if (phase === 'boot') {
        phase = 'error';
        loadError = err.message;
      } else {
        say(`That did not happen: ${err.message}`, 'bad');
      }
    } finally {
      busy = false;
      paint();
    }
  }

  /**
   * `log` asks for a wider slice of the access log. It is a parameter on the
   * ordinary read rather than a route of its own, because every route here
   * answers with the whole state — a second endpoint returning half of it would
   * be the one place the panel had to merge two truths.
   */
  const load = (log = logWindow) => {
    logWindow = log;
    return run(() => (log ? request(`/api/ai?log=${log}`) : api.ai()));
  };

  function setEnabled(next) {
    const v = view();
    const on = v.scopeInfo.filter((s) => v.effective[s.id]).map(nameOf);
    run(() => api.saveAi({ enabled: next }), {
      message: next
        ? (on.length
          ? `Sharing is on. ${capitalise(listWords(on))} can now be read.`
          : 'Sharing is on, but no box is ticked, so there is nothing to read yet.')
        : 'Sharing is off. Nothing is shared, and a program holding a key is turned away.',
    });
  }

  /**
   * One scope, one write. The server stores exactly what it is given and works
   * out `effectiveScopes` itself, so this must not "helpfully" tick mail
   * headers when bodies goes on — the box a person did not touch stays untouched
   * and the row says where the grant came from instead.
   */
  function setScope(scope, next) {
    const v = view();
    pending = null;
    const noun = capitalise(nameOf(scope));
    const tail = v.enabled ? '' : ' The switch is still off, so nothing is shared yet.';
    const extra = scope.exposing && next ? ' Mail headers come with it.' : '';
    run(() => api.saveAi({ scopes: { [scope.id]: next } }), {
      message: `${noun} ${next ? 'is now readable' : 'is no longer readable'}.${extra}${tail}`,
    });
  }

  async function mint(label) {
    if (!label) {
      mintStatus.bad('Give the key a name first — months from now you will want to know which program it belongs to.');
      return;
    }
    mintStatus.working('Creating…');
    await run(() => api.mintAiToken(label), {
      onDone: (res) => {
        const value = typeof res?.value === 'string' ? res.value : '';
        if (!value) {
          mintStatus.bad('Zelos made a key but did not hand back its value, so there is nothing to copy. Revoke it below and try again.');
          return;
        }
        revealed = { label, value, id: res?.token?.id || '' };
        // A freshly minted token is the one the reader is about to try, so it
        // replaces whatever was in the test field — this is the one moment the
        // panel is allowed to write over what they typed, because they just
        // asked for a new token.
        tokenDraft = null;
        mintStatus.clear();
        say('Key created. Copy it now — this is the only time it is shown.');
      },
    });
  }

  function revoke(token) {
    pending = null;
    if (probe?.token?.id === token.id) probe = null;
    run(() => api.revokeAiToken(token.id), {
      onDone: (res) => {
        if (revealed && revealed.id && revealed.id === token.id) revealed = null;
        say(res?.revoked === false
          ? 'That key was already gone.'
          : `${token.label || 'That key'} is revoked. Anything still using it is turned away.`);
      },
    });
  }

  /**
   * Run the handshake an MCP client runs, with a token the user pasted, and
   * show what came back.
   *
   * Deliberately not routed through `run()`: that helper replaces the whole
   * panel payload with whatever the server answered, and this route answers
   * with a test result rather than with the state of the feature. Overwriting
   * the panel's own truth with a probe result is how a screen ends up claiming
   * a scope is on because a *test* said so.
   */
  async function testConnection(value) {
    if (!value) {
      testStatus.bad('Paste a key first — this checks one particular key, not the feature in general.');
      return;
    }
    testStatus.working('Asking the way that program would…');
    try {
      probe = await request('/api/ai/test', { method: 'POST', body: { token: value } });
      testStatus.clear();
      say(probe?.ok
        ? 'It connected. What is listed below is everything that program can reach.'
        : 'That key would not connect. The reason is below.');
    } catch (err) {
      probe = null;
      testStatus.bad(`The test itself could not run: ${err.message}`);
    }
    paint();
  }

  /* --------------------------------------------------------------- parts */

  function masterBlock(v) {
    const noteId = nextId('note');
    const control = el('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': v.enabled ? 'true' : 'false',
      'aria-describedby': noteId,
      onclick: () => setEnabled(!v.enabled),
    }, [
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })),
      el('span', { class: 'switch-text', text: v.enabled ? 'Sharing is on' : 'Sharing is off' }),
    ]);

    return el('div', { class: `ai-master${v.enabled ? ' is-on' : ''}` }, [
      control,
      el('p', {
        class: 'ai-master-note',
        id: noteId,
        text: 'Switching this on lets the other AI program read whatever you tick below, whenever it likes, without asking you again. Switching it off cuts every program off at once, key or no key.',
      }),
      el('p', { class: 'ai-summary', text: exposureLine(v) }),
      live,
    ]);
  }

  function scopeBlock(v, { readOnly = false } = {}) {
    /** Which ticked scope, if any, is what actually opened this one. */
    const grantedBy = (id) => {
      if (v.scopes[id] === true || v.effective[id] !== true) return '';
      const source = v.scopeInfo.find((s) => v.scopes[s.id] === true && s.implies.includes(id));
      return source ? nameOf(source) : '';
    };

    return el('div', { class: 'scope-list' }, v.scopeInfo.map((scope) => scopeRow(scope, {
      ticked: v.scopes[scope.id] === true,
      effective: v.effective[scope.id] === true,
      grantedBy: grantedBy(scope.id),
      readOnly,
      armed: pending?.kind === 'bodies' && pending.id === scope.id,
      onToggle: (next) => setScope(scope, next),
      onArm: () => { pending = { kind: 'bodies', id: scope.id }; paint(); },
      onCancel: () => { pending = null; paint(); },
    })));
  }

  /**
   * The one screen where the token exists — so it is also the one screen that
   * can hand over a config block with nothing left to fill in.
   *
   * Copying a value and then copying a block with a placeholder in it and then
   * putting the first inside the second is three steps, and the failure when a
   * step is missed reads as "unauthorized", which sounds like a bad token
   * rather than a missing one. Both forms are offered because both are real:
   * the stdio one carries no token at all, and saying that out loud is the
   * whole reason it appears here beside one that does.
   */
  function revealBlock(v) {
    if (!revealed) return null;
    const onCopied = (text, tone) => { mintStatus[tone === 'good' ? 'good' : 'bad'](text); };
    return el('div', { class: 'ai-reveal', role: 'group', 'aria-label': 'Your new key' }, [
      el('p', { class: 'ai-reveal-eyebrow', text: `Key for ${revealed.label}` }),
      el('p', { class: 'mono ai-reveal-value', text: revealed.value }),
      el('p', {
        class: 'ai-reveal-warn',
        text: 'This is the only time Zelos will show this key. It is kept in the same place as your mail password, and nothing in Zelos can read it back out — if you lose it, revoke this key and create another.',
      }),
      el('div', { class: 'row-inline' }, [
        button('Copy the key', {
          class: 'btn solid',
          onClick: async () => {
            const ok = await copyText(revealed.value);
            mintStatus[ok ? 'good' : 'bad'](ok
              ? 'Copied. Paste it into the other program before you hide this.'
              : 'Could not reach the clipboard — select the value above and copy it by hand.');
          },
        }),
        button('I have copied it — hide it', {
          class: 'btn quiet',
          onClick: () => { revealed = null; probe = null; mintStatus.clear(); paint(); },
        }),
      ]),
      // The blocks an expert pastes into the other program's own settings
      // file, with this key already written in. Folded: the person who just
      // pressed "Create a key" needs the key and the two buttons above it, and
      // the JSON is for whoever set the program up.
      fold('For experts: connecting it, with this key filled in', [
        codeCard(
          'Ready to paste — any MCP client, over HTTP',
          httpBlock(v.client, revealed.value),
          'This block already holds the key above. It is the whole of what that client needs, and it is only complete while this is on screen.',
          onCopied,
        ),
        spawnCard(
          v.client,
          'Ready to paste — a client that spawns Zelos itself',
          'No key appears in this one, and that is correct: a client that spawns Zelos runs it as you, so the switch and the scopes above are the whole of what holds it back.',
          onCopied,
        ),
      ]),
    ]);
  }

  function tokenBlock(v) {
    const labelInput = input({ placeholder: 'Claude Desktop on this laptop', maxlength: '60' });
    const submit = () => mint(labelInput.value.trim());
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    return el('div', { class: 'ai-tokens' }, [
      el('p', { class: 'field-hint', text: 'The other program proves it is allowed in by showing Zelos a key. Make one key for each program, so revoking one leaves the others working.' }),
      revealBlock(v),
      el('div', { class: 'ai-mint' }, [
        field('Name this key', labelInput, { hint: 'Whatever tells you which program it is. You will be reading this list months from now.' }),
        el('div', { class: 'row-inline' }, button('Create a key for that program', { class: 'btn solid', onClick: submit })),
        mintStatus.node,
      ]),
      v.tokens.length
        ? el('div', { class: 'stack' }, v.tokens.map((token) => tokenRow(token, {
          armed: pending?.kind === 'revoke' && pending.id === token.id,
          onArm: () => { pending = { kind: 'revoke', id: token.id }; paint(); },
          onCancel: () => { pending = null; paint(); },
          onRevoke: () => revoke(token),
        })))
        : el('p', { class: 'quiet-note', text: 'No key has been created yet, so no other program can connect from outside. (For experts: a program that starts Zelos itself needs no key.)' }),
    ]);
  }

  /**
   * The log, newest first, in windows rather than whole.
   *
   * A log that has been running for months is thousands of rows, and a panel
   * that rendered all of them would spend its time laying out a year of pings
   * nobody scrolls to. So the server sends a window — fifty by default — and
   * says whether there are older rows behind it; asking for more asks for a
   * wider window, up to a ceiling the server names rather than one written down
   * here twice.
   */
  function logBlock(v) {
    const wider = Math.min(v.accessMax, Math.max(v.access.length * 4, 200));
    return el('div', { class: 'ai-log-wrap' }, [
      el('p', { class: 'field-hint', text: 'One line for every time the other program asked Zelos for something: what it asked for, which box that came under, how many rows went back and which key asked. This list is kept on this computer and goes nowhere.' }),
      v.access.length
        ? el('div', { class: 'ai-log' }, v.access.map(logRow))
        : el('p', { class: 'quiet-note', text: 'Nothing has read anything yet.' }),
      v.access.length
        ? el('p', {
          class: 'field-hint',
          text: v.accessMore
            ? `The ${plural(v.access.length, 'most recent call')}. There are older ones behind these.`
            : `${capitalise(plural(v.access.length, 'call'))}, which is the whole list.`,
        })
        : null,
      el('div', { class: 'row-inline' }, [
        button('Refresh', { class: 'btn quiet', onClick: () => load() }),
        v.accessMore
          ? button(`Show older (up to ${wider})`, { class: 'btn quiet', onClick: () => load(wider) })
          : null,
        logWindow ? button('Show fewer', { class: 'btn quiet', onClick: () => load(0) }) : null,
      ]),
    ]);
  }

  /**
   * "Does my setup actually work?" — answered here rather than in somebody
   * else's client.
   *
   * It runs the two calls every MCP client makes on connect and prints what
   * came back: the tool list that client would be handed, and the paragraph it
   * would put in front of its model. That list is the honest picture of the
   * grant — shorter than the scope list above whenever a scope is ticked but
   * the switch is off, or a token has been revoked, and those are exactly the
   * two states a person cannot otherwise see from this screen.
   */
  function testBlock(v) {
    const tokenInput = input({
      placeholder: 'zlt_t_… — paste the key the other program is using',
      maxlength: '400',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    // What the reader typed wins over the minted token: they typed it after it
    // was offered, and a repaint is not a reason to take it away from them.
    if (tokenDraft !== null) tokenInput.value = tokenDraft;
    else if (revealed) tokenInput.value = revealed.value;
    const submit = () => testConnection(tokenInput.value.trim());
    tokenInput.addEventListener('input', () => { tokenDraft = tokenInput.value; });
    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    return el('div', { class: 'ai-connect' }, [
      el('p', { class: 'field-hint', text: 'Zelos tries this key on itself, the way the other program would, and shows you exactly what that program would be shown. It reads nothing, changes nothing, and does not count as the key being used.' }),
      field('The key to try', tokenInput, { hint: v.tokens.length ? 'Whatever you pasted into the other program. Zelos cannot read a key back, so this has to come from you.' : 'There is no key yet — create one above first.' }),
      el('div', { class: 'row-inline' }, button('Test connection', { class: 'btn', onClick: submit })),
      testStatus.node,
      probeBlock(),
    ]);
  }

  function probeBlock() {
    if (!isObject(probe)) return null;
    if (probe.ok !== true) {
      return el('div', { class: 'banner banner-warn', role: 'status' }, [
        el('h2', { class: 'banner-title', text: probe.stage === 'switch' ? 'It would be refused at the switch' : 'It would be refused at the door' }),
        el('p', { class: 'banner-detail', text: String(probe.detail || 'The server gave no reason.') }),
      ]);
    }

    const tools = Array.isArray(probe.tools) ? probe.tools.filter(isObject) : [];
    const info = isObject(probe.serverInfo) ? probe.serverInfo : {};
    const named = [
      probe.token?.label ? `connected as ${probe.token.label}` : null,
      info.name ? `${info.name} ${info.version || ''}`.trim() : null,
      probe.protocolVersion ? `protocol ${probe.protocolVersion}` : null,
    ].filter(Boolean).join(' · ');

    return el('div', { class: 'stack' }, [
      el('p', { class: 'status is-good', text: String(probe.detail || 'The handshake worked.') }),
      named ? el('p', { class: 'field-hint', text: named }) : null,
      tools.length
        ? el('p', { class: 'scope-tools' }, [
          el('span', { class: 'scope-tools-label', text: plural(tools.length, 'tool') }),
          ...tools.map((t) => el('code', { class: 'mono scope-tool', text: String(t.name || '') })),
        ])
        : el('p', { class: 'quiet-note', text: 'Nothing at all: every box is off, so that program connects and can read nothing.' }),
      probe.instructions
        ? el('div', { class: 'ai-code' }, [
          el('div', { class: 'ai-code-head' }, el('span', { class: 'ai-code-title', text: 'What the AI is told Zelos is' })),
          el('pre', { class: 'code', tabindex: '0' }, el('code', { text: String(probe.instructions) })),
        ])
        : null,
    ]);
  }

  function connectBlock(v) {
    const onCopied = (text, tone) => { say(text, tone); paintLive(); };
    const known = Boolean(v.client.command);

    return el('div', { class: 'ai-connect' }, [
      el('p', { class: 'field-hint', text: 'The other program has to be told where Zelos is. The drawer below holds the settings to copy into it — whoever set that program up will know where they go.' }),
      // Everything from here down is the expert's: two settings-file blocks,
      // the path to Claude Desktop's own file, and the protocol by name. It
      // is all still here, one press away, and the person who only wanted to
      // know what the switch does never has to read it.
      fold('For experts: connecting it', [
        spawnCard(
          v.client,
          'Claude Desktop, and anything else that spawns a server',
          known
            ? 'Those are the real paths to this copy of Zelos. A client that spawns it this way runs it as you, so it presents no key — the switch above and the scopes below it are the whole of what holds.'
            : 'Generic form: this build did not report where it is installed. Replace the command with the path to your own copy.',
          onCopied,
        ),
        el('p', {
          class: 'field-hint',
          text: 'Claude Desktop keeps that file at ~/Library/Application Support/Claude/claude_desktop_config.json on macOS and %APPDATA%\\Claude\\claude_desktop_config.json on Windows. Merge this into what is already there — a file with two mcpServers keys keeps only the last.',
        }),
        codeCard(
          'Any MCP client, over HTTP',
          httpBlock(v.client),
          'Paste a key you created above in place of the placeholder. This address only answers on this machine, and only while Zelos is running.',
          onCopied,
        ),
      ], { id: 'ai.connect' }),
    ]);
  }

  function limitsBlock() {
    return el('ul', { class: 'plain-list' }, [
      el('li', { text: 'Nothing here sends a message, deletes anything or changes a setting — not a switched-off one, none at all. Everything only reads, except that reading the board does what opening Zelos does: a snooze that has come due wakes, and Now is kept to four items by moving the rest down.' }),
      el('li', { text: 'A box that is unticked is not merely hidden: the other program is not even told that part exists, and a request for it is refused.' }),
      el('li', { text: 'The main switch is checked before the key is, so a key that was made and then switched off cannot be used to look at anything.' }),
      el('li', { text: 'This is a door into what Zelos has collected on this computer. It is not a door into your mailbox — nothing here can reach back to your email provider.' }),
    ]);
  }

  /* --------------------------------------------------------------- build */

  const LEDE = 'If you already use another AI program, such as Claude, you can let it read what Zelos has collected. It is off unless you switch it on.';

  function unavailableBody() {
    const v = view();  // empty payload: the fallback scope list, nothing ticked
    return [
      el('p', { class: 'panel-lede', text: LEDE }),
      el('div', { class: 'banner banner-warn', role: 'status' }, [
        el('h2', { class: 'banner-title', text: 'Not available in this build' }),
        el('p', { class: 'banner-detail', text: 'This copy of Zelos does not have this feature, so there is nothing here to switch on and nothing is shared. What follows is what it would offer and what each choice would hand over, so the decision is already made when a copy that has it arrives. (For experts: /api/ai answered 404.)' }),
      ]),
      section('What each box would hand over', {}, scopeBlock(v, { readOnly: true })),
      section('What it would never do', {}, limitsBlock()),
    ];
  }

  function build() {
    if (phase === 'boot') {
      return [
        el('p', { class: 'panel-lede', text: LEDE }),
        el('p', { class: 'quiet-note', text: 'Asking this copy of Zelos what it can share…' }),
      ];
    }
    if (phase === 'missing') return unavailableBody();
    if (phase === 'error') {
      return [
        el('p', { class: 'panel-lede', text: LEDE }),
        el('div', { class: 'banner banner-warn', role: 'status' }, [
          el('h2', { class: 'banner-title', text: 'This panel could not read its own settings' }),
          el('p', { class: 'banner-detail', text: `${loadError} — until that is answered, treat sharing as unknown rather than off.` }),
          // Wrapped, not handed over: a bare `load` would take the click event
          // as the log window (QA, 2026-10-10, TT-3440).
          el('div', { class: 'banner-actions' }, button('Try again', { class: 'btn quiet', onClick: () => load() })),
        ]),
      ];
    }

    const v = view();
    return [
      el('p', { class: 'panel-lede', text: `${LEDE} What it hands over is exactly what you tick below and nothing else.` }),
      masterBlock(v),
      section('What you are handing over', {
        note: 'Each of these is its own decision. The sentence under each box is the list of things that leave this computer when it is on — read it before you tick it.',
      }, scopeBlock(v)),
      section('Keys', {}, tokenBlock(v)),
      section('Check a key', {}, testBlock(v)),
      section('What your AI has read', {}, logBlock(v)),
      section('Connecting the other program', {}, connectBlock(v)),
      section('What it cannot do', {}, [
        el('p', { class: 'field-hint', text: `Any single answer is capped at ${plural(v.maxRows, 'row')}. That is a ceiling on one ask, not on the day — a program that wants more asks again, and each ask is a line in the list above.` }),
        limitsBlock(),
      ]),
    ];
  }

  /* ---------------------------------------------------------------- boot */

  paint();
  // A payload from an earlier visit is shown at once; the panel still refreshes,
  // because `lastUsedAt` and the access log move without anyone touching this
  // page — the numbers on this screen are the ones people check.
  load();

  return wrap;
}
