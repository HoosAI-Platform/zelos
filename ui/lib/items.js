/**
 * ui/lib/items.js — the item, rendered.
 *
 * One row shape, two sizes: the Now hero and the dense list row. Both are built
 * here so "done" behaves identically everywhere.
 *
 * The done control is a `<button role="checkbox">`, never an `<input>` inside a
 * `<summary>`: a checkbox inside a summary toggles the disclosure on the way to
 * toggling itself, so ticking a row folds it shut under your hand. The tick and
 * the disclosure are separate buttons, side by side, and neither contains the
 * other.
 */

import { el, button, meander, replace } from './dom.js';
import { setItemState, state, timezone } from './store.js';
import { itemHistory } from './item-history.js';
import {
  todayKey, addDaysToKey, weekdayOfKey, dayKey, offsetFor, toZonedISO, formatTime, formatDay,
} from './time.js';
import {
  BUCKET_TAG, severityOf, carriedFor, dueLabel, isOverdue, personLabel, sourceStamp, isNewSince,
} from './format.js';

/* Every deadline on a row goes through dueBit() below, which is the only place
 * in this module allowed to call dueLabel/isOverdue — see its own note. */

/** A safe external link, or null. The server already screened it; so do we. */
function linkFor(item) {
  const raw = item?.link;
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
  return url.href;
}

function tick(item, { label = null } = {}) {
  const done = item.state === 'done';
  const node = el('button', {
    type: 'button',
    class: 'tick',
    role: 'checkbox',
    disabled: item.sourceInactive === true,
    title: item.sourceInactive ? 'Include this task in your source selection again to bring it back.' : null,
    'aria-checked': done ? 'true' : 'false',
    'aria-label': `${label || (done ? 'Reopen' : 'Mark done')}: ${item.headline || 'item'}`,
    onclick: () => { if (!item.sourceInactive) setItemState(item.id, done ? 'open' : 'done'); },
  }, el('span', { class: 'tick-mark', 'aria-hidden': 'true' }));
  return node;
}

/** "until 2 PM" today, "until Tue, Aug 11 9 AM" any other day. */
function untilLabel(iso, tz) {
  const time = formatTime(iso);
  if (dayKey(iso) === todayKey(tz)) return time ? `until ${time}` : null;
  const day = formatDay(iso);
  if (!day) return null;
  return `until ${day}${time ? ` ${time}` : ''}`;
}

/**
 * The deadline, as this app says it: the words and whether they are hot.
 *
 * It exists so that the zone is threaded exactly once. `dueLabel` and
 * `isOverdue` both take a zone and both default it to the BROWSER's, and for a
 * while every row here called them without one — so a bare "due 2026-08-12" was
 * judged against whatever zone the laptop happened to be set to while the
 * carried-for badge beside it was judged in the zone the user configured. The
 * two readings disagree by a whole day for anyone travelling, which is the one
 * time a deadline matters most. Every deadline on a row goes through here, and
 * `now` is passed explicitly so the label and the redness are the same instant.
 */
export function dueBit(item, { tz, now = Date.now() } = {}) {
  // A caller that forgot the zone gets the CONFIGURED one rather than the
  // browser's, which is the failure this helper was written to make impossible.
  const zone = tz || timezone();
  const text = dueLabel(item, now, zone);
  if (!text) return null;
  return { text, hot: isOverdue(item, now, zone) };
}

/**
 * The line's two quietest bits, shared verbatim by the dense row and the hero
 * so the two surfaces cannot drift: "new" — stored timestamps against the last
 * successful check, per isNewSince, never the model's wording — and where the
 * item came from. They go last on purpose, dimmest: the row must still read as
 * one calm line.
 */
function trailBits(item) {
  const bits = [];
  if (isNewSince(item, state.board.runs?.last)) bits.push({ text: 'new', class: 'meta-new' });
  const source = sourceStamp(item);
  if (source) bits.push({ text: source.text, class: source.derived ? 'meta-derived' : '' });
  return bits;
}

function metaLine(item, { tz }) {
  const bits = [];
  const due = dueBit(item, { tz });
  if (due) bits.push({ text: due.text, class: due.hot ? 'meta-hot' : '' });
  const who = personLabel(item);
  if (who) bits.push({ text: who, class: '' });
  const carried = carriedFor(item, todayKey(tz));
  if (carried) bits.push({ text: carried, class: 'meta-carried' });
  if (item.state === 'snoozed' && item.snoozed_until) {
    const until = untilLabel(item.snoozed_until, tz);
    if (until) bits.push({ text: until, class: 'meta-carried' });
  }
  bits.push(...trailBits(item));
  if (!bits.length) return null;
  return el('p', { class: 'meta mono' }, bits.map((b, i) => el('span', {
    class: `meta-bit ${b.class}`.trim(),
    text: i === 0 ? b.text : `· ${b.text}`,
  })));
}

/**
 * 09:00 on the morning of `key`, as an ISO string carrying `tz`'s offset.
 *
 * Two passes over the offset on purpose: the first guess reads the zone's
 * offset at roughly the right instant, and the second re-reads it at the exact
 * instant the guess names, which is the only way a DST changeover sitting
 * between "now" and "tomorrow morning" gets the right side of the fold.
 */
function morningISO(key, tz) {
  const guess = offsetFor(tz, new Date(Date.parse(`${key}T09:00:00Z`)));
  const offset = offsetFor(tz, new Date(Date.parse(`${key}T09:00:00${guess}`)));
  return `${key}T09:00:00${offset}`;
}

/**
 * The three snooze deadlines on offer, computed in the user's configured zone
 * at the moment the chooser opens. The first always means four hours from now,
 * even when that lands tomorrow. Each carries `when`, the clock it is promising,
 * printed on the button so "Tomorrow morning" is legibly 9 AM before the click
 * rather than after the surprise.
 */
export function snoozeChoices(tz, now = Date.now()) {
  const today = dayKey(toZonedISO(new Date(now), tz));
  const wd = weekdayOfKey(today);
  // "Next week" is Monday morning, and from a Monday it means the NEXT one.
  const monday = addDaysToKey(today, ((1 - wd + 7) % 7) || 7);
  const later = toZonedISO(new Date(now + 4 * 3_600_000), tz);
  const tomorrow = morningISO(addDaysToKey(today, 1), tz);
  const nextWeek = morningISO(monday, tz);
  return [
    { label: 'In 4 hours', when: dayKey(later) === today ? formatTime(later) : `${formatDay(later)} ${formatTime(later)}`, until: later },
    { label: 'Tomorrow morning', when: formatTime(tomorrow), until: tomorrow },
    { label: 'Next week', when: `${formatDay(nextWeek)} ${formatTime(nextWeek)}`, until: nextWeek },
  ];
}

/**
 * The snooze control: a quiet button that unfolds concrete deadlines rather
 * than acting on the click itself. "Snooze" with no time attached was the old
 * behaviour, and it produced rows that slept until someone remembered they
 * existed. The fourth choice unfolds a day of your own — "deal with it
 * Saturday" — which comes back the way "Tomorrow morning" does: 9:00 that
 * morning, through the same morningISO. One promise, one clock.
 */
function snoozeControl(item) {
  const panel = el('div', { class: 'snooze-menu', hidden: true });
  const toggle = el('button', {
    type: 'button',
    class: 'btn quiet',
    'aria-expanded': 'false',
    'aria-label': `Snooze ${item.headline || 'this item'}`,
    onclick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (!open) {
        const tz = timezone();
        const min = addDaysToKey(todayKey(tz), 1);
        const errorId = `snooze-date-error-${item.id}`;
        const error = el('p', { id: errorId, class: 'quiet-note is-bad', role: 'status' });
        const checkDate = (showEmpty = false) => {
          const stamp = Date.parse(`${day.value}T12:00:00Z`);
          const valid = /^\d{4}-\d{2}-\d{2}$/.test(day.value)
            && Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day.value
            && day.value >= min;
          const showError = !valid && (Boolean(day.value) || showEmpty);
          confirm.disabled = !valid;
          day.setAttribute('aria-invalid', showError ? 'true' : 'false');
          error.textContent = showError ? 'Choose a valid date from tomorrow onward.' : '';
          return valid;
        };
        const day = el('input', {
          type: 'date',
          class: 'input snooze-day',
          min,
          'aria-label': 'The day it comes back',
          'aria-describedby': errorId,
          oninput() { checkDate(); },
        });
        const confirm = button('Back that morning · 9 AM', {
          class: 'btn quiet',
          disabled: true,
          onClick: () => {
            if (!checkDate(true)) return;
            setItemState(item.id, 'snoozed', { until: morningISO(day.value, tz) });
          },
        });
        const pick = el('div', { class: 'snooze-pick', hidden: true }, [day, confirm, error]);
        replace(panel, [
          ...snoozeChoices(tz).map(({ label, when, until }) =>
            button(`${label} · ${when}`, {
              class: 'btn quiet',
              onClick: () => setItemState(item.id, 'snoozed', { until }),
            })),
          button('Pick a day…', {
            class: 'btn quiet',
            'aria-expanded': 'false',
            onClick() {
              const showing = this.getAttribute('aria-expanded') === 'true';
              this.setAttribute('aria-expanded', showing ? 'false' : 'true');
              pick.hidden = showing;
            },
          }),
          pick,
        ]);
      }
      panel.hidden = open;
    },
  }, 'Snooze');
  return { toggle, panel };
}

/**
 * The extra controls. Behind a disclosure because "done" is the answer 90% of
 * the time and three equal buttons make you read all three.
 */
function moreControls(item) {
  const snooze = item.sourceInactive ? null : snoozeControl(item);
  const history = itemHistory(item);
  const panel = el('div', { class: 'row-more', hidden: true }, [
    snooze?.toggle,
    !item.sourceInactive ? button('Not a thing', {
      class: 'btn quiet',
      onClick: () => setItemState(item.id, 'dismissed'),
      title: 'Dismiss — it stays in the database, it just leaves the board',
    }) : null,
    !item.sourceInactive && item.state === 'snoozed'
      ? button('Wake', { class: 'btn quiet', onClick: () => setItemState(item.id, 'open') })
      : null,
    history.toggle,
    snooze?.panel,
    history.panel,
  ]);

  // Three dots are a picture, not a name. "More" is the name, in the tooltip
  // a pointer hovers and in the label a screen reader speaks — with the
  // headline after it, so a list of rows does not read as a list of "More".
  const toggle = el('button', {
    type: 'button',
    class: 'disclosure',
    'aria-expanded': 'false',
    title: 'More',
    'aria-label': `More — ${item.headline || 'this item'}`,
    onclick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    },
  }, el('span', { class: 'disclosure-dots', 'aria-hidden': 'true', text: '···' }));

  return { toggle, panel };
}

/** The dense row used by Today, Owed and the Now list. */
export function itemRow(item, { tz, showBucket = true } = {}) {
  const sev = severityOf(item);
  const { toggle, panel } = moreControls(item);
  const link = linkFor(item);

  return el('article', {
    class: `row sev-${sev}${item.state === 'snoozed' ? ' is-snoozed' : ''}`,
    dataset: { bucket: item.bucket },
  }, [
    el('div', { class: 'row-main' }, [
      tick(item),
      el('div', { class: 'row-body' }, [
        el('div', { class: 'row-head' }, [
          el('h3', { class: 'headline', text: item.headline || '(no headline)' }),
          showBucket ? el('span', { class: 'chip', text: BUCKET_TAG[item.bucket] || item.bucket }) : null,
        ]),
        item.why ? el('p', { class: 'why', text: item.why }) : null,
        metaLine(item, { tz }),
        item.sourceInactive ? el('p', { class: 'quiet-note', text: 'No longer in task selection. To bring it back, include this task in your source selection again.' }) : null,
      ]),
      el('div', { class: 'row-tools' }, [
        !item.sourceInactive && ['done', 'dismissed'].includes(item.state)
          ? button(item.state === 'done' ? 'Reopen' : 'Restore', {
            class: 'btn quiet',
            'aria-label': `${item.state === 'done' ? 'Reopen' : 'Restore'}: ${item.headline || 'item'}`,
            onClick: () => setItemState(item.id, 'open'),
          }) : null,
        link ? el('a', {
          class: 'btn quiet',
          href: link,
          rel: 'noreferrer noopener',
          target: '_blank',
          text: 'Open',
        }) : null,
        toggle,
      ]),
    ]),
    panel,
  ]);
}

/**
 * The hero. One item, the one the model ranked first — given the size that says
 * "if you do one thing".
 */
export function itemHero(item, { tz } = {}) {
  const link = linkFor(item);
  const carried = carriedFor(item, todayKey(tz));
  const due = dueBit(item, { tz });
  // The SAME controls the dense rows get, not a private subset. The commonest
  // model error is a top pick that is noise, and a hero whose only exits were
  // a false "done" or a snooze fed the resolved noise back into the next
  // prompt as if it had been real. Snooze alone also keeps its own button:
  // it is the hero's most-used second action, and burying it two clicks deep
  // to gain "Not a thing" would trade one demotion for another.
  const more = moreControls(item);
  const snooze = snoozeControl(item);

  return el('article', { class: `hero sev-${severityOf(item)}` }, [
    el('p', { class: 'hero-eyebrow', text: 'Do this first' }),
    meander({ class: 'hero-rule' }),
    el('h2', { class: 'hero-headline', text: item.headline || '(no headline)' }),
    item.why ? el('p', { class: 'hero-why', text: item.why }) : null,
    el('p', { class: 'hero-meta mono' }, [
      due ? el('span', { class: due.hot ? 'meta-hot' : '', text: due.text }) : null,
      personLabel(item) ? el('span', { text: personLabel(item) }) : null,
      carried ? el('span', { class: 'meta-carried', text: carried }) : null,
      ...trailBits(item).map((b) => el('span', { class: b.class || null, text: b.text })),
    ]),
    el('div', { class: 'hero-actions' }, [
      button('Done', { class: 'btn solid', onClick: () => setItemState(item.id, 'done') }),
      snooze.toggle,
      link ? el('a', {
        class: 'btn quiet',
        href: link,
        rel: 'noreferrer noopener',
        target: '_blank',
        text: 'Open',
      }) : null,
      more.toggle,
    ]),
    snooze.panel,
    more.panel,
  ]);
}

/**
 * A list that never silently drops anything: `visible` rows, then a button that
 * says exactly how many are behind it.
 */
export function foldedList(items, render, { visible = 8, moreLabel = 'show the other' } = {}) {
  const wrap = el('div', { class: 'stack' });
  const head = items.slice(0, visible);
  const tail = items.slice(visible);
  for (const item of head) wrap.appendChild(render(item));

  if (tail.length) {
    const tailWrap = el('div', { class: 'stack', hidden: true },
      tail.map((item) => render(item)));
    const toggle = el('button', {
      type: 'button',
      class: 'fold',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        tailWrap.hidden = open;
        this.textContent = open ? `${moreLabel} ${tail.length}` : 'show fewer';
      },
    }, `${moreLabel} ${tail.length}`);
    wrap.appendChild(tailWrap);
    wrap.appendChild(toggle);
  }
  return wrap;
}

/**
 * An empty state with a point of view: what is true, and what to do next.
 * `action` is optional — a state with nothing to do gets a full stop instead.
 */
export function emptyState({ title, detail, action = null }) {
  return el('div', { class: 'empty' }, [
    meander({ class: 'empty-rule' }),
    el('h2', { class: 'empty-title', text: title }),
    detail ? el('p', { class: 'empty-detail', text: detail }) : null,
    action,
  ]);
}
