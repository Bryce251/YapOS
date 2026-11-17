import { h, button } from './dom.js';
import { REASON_NOTE_MAX, cleanReasonNote } from '../admin.js';

export const TEXT_FLAG_ICON = '⚑';
export const TEXT_FLAG_LABEL = 'Report';
export const TEXT_FLAG_TITLE = 'Report this';
export const TEXT_FLAG_DONE = 'Reported';
export const TEXT_FLAG_THANKS = 'Thanks for the report. The YapOS team will take a look.';
export const TEXT_FLAG_SLOW = "You've sent a lot of reports. Try again in a minute.";
export const TEXT_FLAG_FAIL = "That didn't go through. Try again in a moment.";
export const REASON_TITLE = 'Why are you reporting this?';
export const REASON_NOTE_HINT = 'Add a short note (optional)';
export const REASON_CHOICES = Object.freeze([
  Object.freeze({ id: 'rude', label: 'Rude or inappropriate', icon: '🤬' }),
  Object.freeze({ id: 'spam', label: 'Spam', icon: '📢' }),
  Object.freeze({ id: 'cheating', label: 'Cheating', icon: '🃏' }),
  Object.freeze({ id: 'other', label: 'Something else', icon: '💬' }),
]);

let open = null;

function docOf(doc) {
  if (doc) return doc;
  return typeof document !== 'undefined' ? document : null;
}

export function reasonOpen() {
  return open ? open.el : null;
}

export function closeReason() {
  if (open) open.finish(null);
}

export function pickReason({ doc = null, title = REASON_TITLE } = {}) {
  const d = docOf(doc);
  closeReason();
  if (!d || !d.body) return Promise.resolve(null);
  return new Promise((resolve) => {
    const back = d.activeElement || null;
    let done = false;
    const note = h('input', {
      class: 'reason-note',
      type: 'text',
      dataset: { key: 'reason-note' },
      attrs: { maxlength: String(REASON_NOTE_MAX), placeholder: REASON_NOTE_HINT, 'aria-label': REASON_NOTE_HINT, autocomplete: 'off', spellcheck: 'false' },
    });
    const send = button('Send report', { variant: 'primary', size: 'sm', key: 'reason-send', on: () => finish({ reason: 'other', reasonNote: cleanReasonNote(note.value) }) });
    const extra = h('div', { class: 'reason-extra', attrs: { hidden: true } }, note, send);
    extra.hidden = true;
    const choices = REASON_CHOICES.map((c) =>
      button(c.label, {
        variant: 'secondary',
        key: `reason-${c.id}`,
        on: () => (c.id === 'other' ? showNote() : finish({ reason: c.id })),
        kids: h('span', { class: 'btn-icon reason-icon', text: c.icon, attrs: { 'aria-hidden': 'true' } }),
      }),
    );
    const cancel = button('Cancel', { variant: 'ghost', size: 'sm', key: 'reason-cancel', on: () => finish(null) });
    const card = h(
      'section',
      { class: ['signin-card', 'reason-card'], attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reason-title', tabindex: '-1' } },
      h('h2', { class: 'reason-title', text: title, attrs: { id: 'reason-title' } }),
      h('div', { class: 'reason-grid' }, choices),
      extra,
      h('div', { class: 'reason-actions' }, cancel),
    );
    const shade = h('div', { class: 'signin-backdrop', attrs: { 'aria-hidden': 'true' } });
    const el = h('div', { class: ['signin-layer', 'reason-layer'] }, shade, card);
    shade.addEventListener('click', () => finish(null));
    el.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && e.target === note) {
        e.preventDefault();
        send.click();
      }
    });

    function showNote() {
      extra.hidden = false;
      for (const b of choices) b.classList.toggle('is-picked', b.dataset.key === 'reason-other');
      try {
        note.focus();
      } catch {}
    }

    function finish(value) {
      if (done) return;
      done = true;
      if (open && open.el === el) open = null;
      el.remove();
      if (back && typeof back.focus === 'function' && back.isConnected !== false) {
        try {
          back.focus();
        } catch {}
      }
      resolve(value);
    }

    open = { el, finish };
    d.body.append(el);
    try {
      choices[0].focus();
    } catch {}
  });
}

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
  btn.addEventListener('click', async (e) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (btn.disabled) return;
    const why = await pickReason({ doc: btn.ownerDocument || null });
    if (!why || btn.disabled) return;
    let res = 'no';
    try {
      res = engine.report(r, why);
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
