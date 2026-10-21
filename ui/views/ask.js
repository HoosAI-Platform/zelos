/**
 * ui/views/ask.js — a question against your own index.
 *
 * The answer is streamed from POST /api/ask, which grounds it in FTS5 hits over
 * your mail, calendar, items and notes. The sources arrive first, as their own
 * SSE event, and they are rendered before a single token of the answer — so what
 * the model was allowed to look at is visible whether or not you like what it
 * said.
 *
 * This view owns a persistent root node. A sweep finishing mid-answer must not
 * re-render the transcript out from under a stream that is still running.
 *
 * An answer in progress can be stopped, and stopping keeps every word that had
 * already arrived — a long answer going the wrong way is a thing you interrupt,
 * not a thing you throw away. A question that failed goes back into the field
 * for the same reason: the retry is the point, and retyping it is not.
 */

import { el, button, meander, copyText } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import { openStream, ApiError } from '../lib/api.js';
import { state } from '../lib/store.js';
import { messageLabel } from '../lib/format.js';

let root = null;
let transcript = null;
let form = null;
let field = null;
let askButton = null;
let stopButton = null;
let controller = null;
let navigateTo = null;
/** What Stop does right now, or null when nothing is streaming. */
let stopCurrent = null;

const KIND_LABEL = { message: 'mail', event: 'calendar', item: 'board', capture: 'note' };

function sourceList(sources) {
  if (!sources.length) return null;
  return el('div', { class: 'sources' }, [
    el('p', { class: 'sources-title mono', text: 'read from' }),
    el('ul', { class: 'sources-list' }, sources.map((s) => el('li', { class: 'source' }, [
      el('span', { class: 'source-kind mono', text: s.kind === 'message' ? messageLabel(s.origin) : KIND_LABEL[s.kind] || s.kind || 'source' }),
      el('span', { class: 'source-title', text: s.title || s.ref }),
      s.sourceInactive ? el('span', { class: 'source-excerpt', text: 'No longer in task selection' }) : null,
      s.excerpt ? el('span', { class: 'source-excerpt', text: s.excerpt }) : null,
    ]))),
  ]);
}

/**
 * One question and its answer. The copy button is built with the exchange but
 * stays hidden until there is something to copy: an affordance offered over an
 * empty answer copies an empty string, which is worse than not offering it.
 */
function exchange(question) {
  const answer = el('div', { class: 'answer', 'aria-live': 'polite', 'aria-busy': 'true' });
  const sourcesSlot = el('div', { class: 'sources-slot' });
  const copyButton = button('Copy', {
    class: 'btn quiet',
    onClick: async (e) => {
      // Before the await: a browser resets currentTarget to null once the
      // event has finished dispatching, so read after it the label never
      // changed and the page threw (QA, 2026-10-10, TT-3452).
      const btn = e.currentTarget;
      const ok = await copyText(answer.textContent || '');
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1_600);
    },
  });
  const actions = el('div', { class: 'exchange-actions', hidden: true }, [copyButton]);
  // Anything said ABOUT the answer sits outside it, so Copy hands over what the
  // model wrote and nothing else.
  const noteSlot = el('div', { class: 'exchange-note-slot' });
  const node = el('article', { class: 'exchange' }, [
    el('p', { class: 'question' }, [
      el('span', { class: 'question-mark mono', text: 'Q' }),
      el('span', { text: question }),
    ]),
    sourcesSlot,
    answer,
    noteSlot,
    actions,
  ]);
  return { node, answer, sourcesSlot, actions, noteSlot };
}

/**
 * Ask, and stream the answer in.
 *
 * Two pieces of bookkeeping here are load-bearing. The controller is compared
 * by identity before anything is cleaned up, because a question asked while a
 * previous one is still streaming leaves two of these running: the older one's
 * `finally` would otherwise re-enable the form and null out the controller
 * belonging to the answer still arriving, leaving Stop pointing at nothing.
 * And the question is put back in the field if the exchange failed — losing
 * what you typed because the model was misconfigured means typing it again to
 * find out whether the fix worked.
 */
async function ask(question) {
  if (controller) controller.abort();
  const mine = new AbortController();
  controller = mine;
  let stoppedByUser = false;
  let failed = false;

  const { node, answer, sourcesSlot, actions, noteSlot } = exchange(question);
  transcript.prepend(node);
  answer.textContent = 'Thinking…';
  answer.classList.add('is-waiting');
  askButton.disabled = true;
  askButton.textContent = 'Answering…';
  stopButton.hidden = false;
  stopCurrent = () => {
    stoppedByUser = true;
    mine.abort();
  };

  // `started` is "the placeholder is gone"; `gotAnswer` is "the model actually
  // said something". They differ on the run that produces nothing but an error
  // message, which is written into the answer but is not an answer — there is
  // nothing there worth a Copy button, and the question is worth keeping.
  let started = false;
  let gotAnswer = false;
  const write = (text) => {
    if (!started) {
      answer.textContent = '';
      answer.classList.remove('is-waiting');
      started = true;
    }
    answer.appendChild(document.createTextNode(text));
  };

  try {
    await openStream('/api/ask', {
      method: 'POST',
      body: { question },
      signal: mine.signal,
      onEvent(event, data) {
        if (event === 'sources') {
          sourcesSlot.replaceChildren();
          const list = sourceList(Array.isArray(data) ? data : []);
          if (list) sourcesSlot.appendChild(list);
        } else if (event === 'delta') {
          gotAnswer = true;
          write(String(data?.text ?? ''));
        } else if (event === 'done' && data?.stopReason === 'length') {
          noteSlot.appendChild(el('p', {
            class: 'exchange-note mono',
            text: 'The AI reached its answer limit, so this reply may be incomplete. Try a narrower question.',
          }));
        } else if (event === 'error') {
          failed = true;
          write(`\n\n${String(data?.error || 'the AI stopped answering')}`);
          answer.classList.add('is-bad');
        }
      },
    });
    if (!started) {
      answer.textContent = 'The AI returned nothing.';
      answer.classList.remove('is-waiting');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      failed = true;
      answer.classList.remove('is-waiting');
      answer.classList.add('is-bad');
      answer.textContent = err instanceof ApiError && err.status === 409
        ? 'No AI has been chosen yet. Pick one under Settings → AI and ask again.'
        : err.message;
    }
  } finally {
    // A stop keeps every word that had already arrived — that is the whole
    // point of stopping rather than asking something else — and says so, so a
    // half-finished paragraph is not mistaken for the model's whole answer.
    if (stoppedByUser) {
      answer.classList.remove('is-waiting');
      if (gotAnswer) {
        noteSlot.appendChild(el('p', { class: 'exchange-note mono', text: 'Stopped — this is as far as it got.' }));
      } else {
        answer.textContent = 'Stopped before the AI said anything.';
      }
    }
    answer.setAttribute('aria-busy', 'false');
    actions.hidden = !gotAnswer;
    // Only the stream that is actually current may hand the form back. An older
    // one finishing its abort must not re-enable Ask under a live answer.
    if (controller === mine) {
      controller = null;
      stopCurrent = null;
      stopButton.hidden = true;
      askButton.disabled = false;
      askButton.textContent = 'Ask';
      // The field was cleared when the question went out. If nothing came back,
      // it goes back in — unless the user has already typed the next question,
      // which is theirs and must not be overwritten.
      if (failed && !gotAnswer && !field.value.trim()) field.value = question;
    }
  }
}

function build() {
  field = el('textarea', {
    class: 'ask-field',
    rows: '2',
    placeholder: 'What did Marcus say about the survey?',
    'aria-label': 'Your question',
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  askButton = el('button', { type: 'submit', class: 'btn solid', text: 'Ask' });

  // One Stop button for the page, not one per exchange: only one answer streams
  // at a time, and a row of dead Stop buttons down the transcript would be a
  // control that means nothing everywhere except the top.
  stopButton = button('Stop', {
    class: 'btn quiet',
    hidden: true,
    onClick: () => { if (stopCurrent) stopCurrent(); },
  });

  form = el('form', { class: 'ask-form' }, [
    field,
    el('div', { class: 'ask-actions' }, [
      askButton,
      stopButton,
      el('span', { class: 'ask-hint mono', text: '⌘↵' }),
    ]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = field.value.trim();
    if (!question) return;
    field.value = '';
    ask(question);
  });

  transcript = el('div', { class: 'transcript' });

  root = el('div', { class: 'view view-ask' }, [
    el('p', { class: 'ask-lede', text: 'Ask about your own mail, calendar and notes. The answer comes from what Zelos has read on this computer — and it lists what it looked at.' }),
    form,
    meander(),
    transcript,
  ]);
}

export function renderAsk(ctx) {
  navigateTo = ctx.navigate;
  if (!root) build();

  if (!state.health?.model?.configured) {
    return el('div', { class: 'view view-ask' }, emptyState({
      title: 'Ask needs an AI',
      detail: 'Questions are answered by the AI you choose — one you hold the key to, or one running on this computer. Nothing is asked of anything you have not set up.',
      action: button('Choose an AI', { class: 'btn solid', onClick: () => navigateTo('#/settings/model') }),
    }));
  }
  return root;
}
