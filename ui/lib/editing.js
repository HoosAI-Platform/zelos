/**
 * ui/lib/editing.js — "is someone in the middle of typing into the view?"
 *
 * The shell queues a data-driven redraw while the answer is yes, and runs it
 * when focus settles somewhere the answer is no (ui/app.js, render() and the
 * focusout/pointerup handlers). Pure and DOM-shaped only, so the rule can be
 * tested against the real shell without a browser.
 *
 * A focused text control always counts. So does a focused BUTTON inside an
 * editing region, because Tab from the last field rests focus on Save: a
 * redraw flushed in that moment rebuilds the panel from the stored settings,
 * and whatever was typed — and the focus with it — is gone before Save can be
 * pressed (QA, 2026-10-10, TT-3465). An editing region is one of:
 *
 *   - `form` — Ask and Search, whose submit button is part of what is typed;
 *   - `.account-form` — the open editors in Email, Calendars and Other
 *     things it can read, the same cards onboarding's email step shows;
 *   - `[data-editing-region]` — a panel whose Save sits in a plain div
 *     rather than an editor: You, AI, Schedule and Privacy mark themselves,
 *     and the AI panel carries the mark into onboarding with it.
 *
 * The marker goes on those panels and NOT on every Settings panel. Focus
 * stays on a clicked button, so marking Your data, About, Colour or "Share
 * with another AI" would hold their redraws back for as long as focus is
 * left on a button just pressed there — panels with nothing typed in them to
 * protect, which should keep following the data the way an item row's tick
 * does.
 *
 * One known edge, the same one `.account-form` already has: a click whose
 * handler removes its own focused button — AI's "Forget the stored key"
 * saves, then redraws its form — leaves the redraw that save queued waiting
 * until the next focusout or pointerup, because no focus move announces that
 * the button is gone. The redraw is held, not lost.
 */

export const EDITING_SELECTOR = 'form, .account-form, [data-editing-region]';

const TEXT_CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when `active` sits inside `main` and is a text control, or anything inside an editing region. */
export function isEditing(active, main) {
  if (!active || !main || !main.contains(active)) return false;
  if (TEXT_CONTROLS.has(String(active.tagName || '').toUpperCase())) return true;
  return typeof active.closest === 'function' && Boolean(active.closest(EDITING_SELECTOR));
}
