/**
 * ui/views/today.js — the dense list.
 *
 * Eight rows visible, the tail folded behind a button that states its own count.
 * Nothing is dropped: a board that quietly truncates is a board you cannot
 * trust, and trusting it is the entire proposition.
 */

import { el, button, section } from '../lib/dom.js';
import { itemRow, foldedList, emptyState } from '../lib/items.js';
import { byUrgency, plural, eventSpanOnDay, eventTimeLabel } from '../lib/format.js';
import { state, itemsInBucket, startSweep, nowMark } from '../lib/store.js';

const VISIBLE = 8;

/** Today's calendar, as a strip above the list — context, not a second board. */
function agendaStrip() {
  const { key, minutes } = nowMark();
  if (!key) return null;
  const today = state.board.events
    .map((event) => {
      const span = eventSpanOnDay(event, key);
      return span ? { event, ...span } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  if (!today.length) return null;

  return el('div', { class: 'agenda' }, today.map(({ event, start, end }) => {
    const past = minutes !== null && minutes >= end;
    return el('div', {
      class: `agenda-item${past ? ' is-past' : ''}${minutes !== null && minutes >= start && minutes < end ? ' is-live' : ''}`,
    }, [
      // Ended is drawn as an outline in quieter ink; this says it in words.
      past ? el('span', { class: 'visually-hidden', text: 'Ended: ' }) : null,
      el('span', { class: 'agenda-time mono', text: eventTimeLabel(event) }),
      el('span', { class: 'agenda-title', text: event.title || '(untitled)' }),
      event.location ? el('span', { class: 'agenda-where', text: event.location }) : null,
    ]);
  }));
}

export function renderToday(ctx) {
  const { tz, navigate } = ctx;
  const today = itemsInBucket('today').sort(byUrgency);
  const soon = itemsInBucket('soon').sort(byUrgency);
  const money = itemsInBucket('money').sort(byUrgency);

  const body = el('div', { class: 'view view-today' });

  const strip = agendaStrip();
  if (strip) body.appendChild(section('On the clock', {}, strip));

  if (!today.length && !soon.length && !money.length) {
    // Three different reasons for an empty list, three different next steps.
    // "Check now" when there is no AI to check with is a button that fails.
    const configured = Boolean(state.health?.model?.configured);
    const swept = Boolean(state.board.runs?.last);
    body.appendChild(emptyState({
      title: configured ? 'Today is clear' : 'Nothing has been read yet',
      detail: !configured
        ? 'Zelos sorts what arrives into today, soon and later — once you have chosen an AI for it to think with.'
        : swept
          ? 'Nothing landed in today. Now has the things that cannot wait.'
          : 'Press Check now and Zelos will sort what arrived into today, soon and later.',
      action: !configured
        ? button('Choose an AI', { class: 'btn solid', onClick: () => navigate('#/settings/model') })
        : swept
          ? button('Open Now', { class: 'btn quiet', onClick: () => navigate('#/now') })
          : button('Check now', { class: 'btn solid', onClick: () => startSweep('full') }),
    }));
    return body;
  }

  if (today.length) {
    body.appendChild(section('Today', { count: today.length },
      foldedList(today, (item) => itemRow(item, { tz, showBucket: false }), {
        visible: VISIBLE,
        moreLabel: 'show the other',
      })));
  }

  if (money.length) {
    // "Money" alarmed the audit's reader — does it know about my bank? — so
    // the note says where these come from: the mail, and nowhere else.
    body.appendChild(section('Money', { count: money.length, note: 'Bills and invoices found in your mail.' },
      foldedList(money, (item) => itemRow(item, { tz, showBucket: false }), { visible: 5 })));
  }

  if (soon.length) {
    body.appendChild(section('Soon', { count: soon.length, note: `${plural(soon.length, 'thing')} with room to breathe.` },
      foldedList(soon, (item) => itemRow(item, { tz, showBucket: false }), { visible: VISIBLE })));
  }

  return body;
}
