import { h } from './dom.js';

export const TEXT_FLAG_ICON = '⚑';
export const TEXT_FLAG_LABEL = 'Report';
export const TEXT_FLAG_TITLE = 'Report this';
export const TEXT_FLAG_DONE = 'Reported';
export const TEXT_FLAG_THANKS = 'Thanks for the report. The YapOS team will take a look.';
export const TEXT_FLAG_SLOW = "You've sent a lot of reports. Try again in a minute.";
export const TEXT_FLAG_FAIL = "That didn't go through. Try again in a moment.";

export function canReport(engine) {
  if (!engine || typeof engine.report !== 'function') return false;
  try {
    return typeof engine.canReport === 'function' ? Boolean(engine.canReport()) : true;
  } catch {
    return false;
  }
}

function isReported(engine, r) {
  try {
    return typeof engine.reported === 'function' && Boolean(engine.reported(r));
  } catch {
    return false;
  }
}

function markReported(btn) {
  btn.classList.add('is-reported');
  btn.disabled = true;
  btn.setAttribute('aria-label', TEXT_FLAG_DONE);
  btn.setAttribute('title', TEXT_FLAG_DONE);
  const label = btn.querySelector('.text-flag-label');
  if (label) label.textContent = TEXT_FLAG_DONE;
}

export function textFlag(engine, r, { toast, corner = false } = {}) {
  if (!r || !canReport(engine)) return null;
  const done = isReported(engine, r);
  const say = (t) => {
    if (typeof toast === 'function') toast(t);
  };
  const btn = h(
    'button',
    {
      class: ['text-flag', corner ? 'is-corner' : null, done ? 'is-reported' : null],
      type: 'button',
      dataset: { key: `report-${r}`, report: r },
      disabled: done,
      attrs: { 'aria-label': done ? TEXT_FLAG_DONE : TEXT_FLAG_LABEL, title: done ? TEXT_FLAG_DONE : TEXT_FLAG_TITLE },
    },
    h('span', { class: 'text-flag-icon', text: TEXT_FLAG_ICON, attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'text-flag-label', text: done ? TEXT_FLAG_DONE : '' }),
  );
  btn.addEventListener('click', (e) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (btn.disabled) return;
    let res = 'no';
    try {
      res = engine.report(r);
    } catch {
      res = 'no';
    }
    if (res === 'sent' || res === 'done') {
      markReported(btn);
      if (res === 'sent') say(TEXT_FLAG_THANKS);
      return;
    }
    say(res === 'slow' ? TEXT_FLAG_SLOW : TEXT_FLAG_FAIL);
  });
  return btn;
}
