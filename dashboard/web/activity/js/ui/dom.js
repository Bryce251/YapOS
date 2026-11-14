export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const p = props || {};
  if (p.class) el.className = Array.isArray(p.class) ? p.class.filter(Boolean).join(' ') : p.class;
  if (p.text !== undefined && p.text !== null) el.textContent = String(p.text);
  for (const [k, v] of Object.entries(p.attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(p.dataset || {})) {
    if (v !== undefined && v !== null) el.dataset[k] = String(v);
  }
  for (const [k, v] of Object.entries(p.vars || {})) {
    if (v !== undefined && v !== null && k.startsWith('--')) el.style.setProperty(k, String(v));
  }
  for (const [k, fn] of Object.entries(p.on || {})) el.addEventListener(k, fn);
  if (p.disabled) el.disabled = true;
  if (p.type) el.type = p.type;
  if (p.src) el.src = p.src;
  if (p.alt !== undefined) el.alt = p.alt;
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function swap(container, ...kids) {
  const active = document.activeElement;
  const key = active && container.contains(active) && active.dataset ? active.dataset.key : null;
  container.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  if (key) {
    const again = container.querySelector(`[data-key="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key}"]`);
    if (again && typeof again.focus === 'function') again.focus();
  }
}

export function memo(render) {
  let last = null;
  return (container, model) => {
    const sig = JSON.stringify(model);
    if (sig === last) return false;
    last = sig;
    swap(container, render(model));
    return true;
  };
}

export function button(label, { variant = 'ghost', size, key, on, disabled, attrs, kids } = {}) {
  return h(
    'button',
    {
      class: ['btn', `btn-${variant}`, size ? `btn-${size}` : null, 'spot'],
      type: 'button',
      dataset: { key },
      on: on ? { click: on } : undefined,
      disabled,
      attrs,
    },
    kids || null,
    h('span', { class: 'btn-label', text: label }),
  );
}

export function uidOf(p) {
  return p && p.id !== undefined && p.id !== null && p.id !== '' ? String(p.id) : null;
}

export const NAME_MARKS = ['is-clown', 'is-spotlit'];

export function markNames(root, marks = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const el of root.querySelectorAll('[data-uid]')) {
    const id = el.getAttribute('data-uid');
    for (const cls of NAME_MARKS) {
      const ids = marks[cls];
      const on = Boolean(ids && (ids.has('*') || ids.has(id)));
      if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
      if (on) n += 1;
    }
  }
  return n;
}

export function avatar(p, size = 'md') {
  const wrap = h('span', { class: ['avatar', `avatar-${size}`], vars: { '--hue': p.hue ?? 20 }, attrs: { 'aria-hidden': 'true', 'data-uid': uidOf(p) } });
  if (p.avatar) {
    wrap.classList.add('has-img');
    const img = h('img', { alt: '', attrs: { loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' } });
    img.addEventListener('error', () => {
      img.remove();
      wrap.classList.remove('has-img');
      wrap.textContent = p.initials || '?';
    });
    img.src = p.avatar;
    wrap.append(img);
  } else {
    wrap.textContent = p.initials || '?';
  }
  return wrap;
}

export function who(p, { size = 'md', you = true, extra = null } = {}) {
  return h(
    'span',
    { class: 'who' },
    avatar(p, size),
    h(
      'span',
      { class: 'who-text' },
      h('span', { class: 'who-line' }, h('strong', { class: 'who-name', text: p.name, attrs: { 'data-uid': uidOf(p) } }), you && p.isMe ? h('span', { class: 'tag', text: 'you' }) : null, extra),
      p.username ? h('span', { class: 'who-handle', text: `@${p.username}` }) : null,
    ),
  );
}

export function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function countdown(starts, ends, { lead = 'Starting in', label = 'Time until the game starts' } = {}) {
  return h(
    'div',
    { class: 'countdown', dataset: { starts, ends, lead }, attrs: { role: 'timer', 'aria-label': label } },
    h('span', { class: 'countdown-text' }, h('span', { class: 'countdown-lead', text: `${lead} ` }), h('strong', { class: 'countdown-num', text: '' })),
    h('span', { class: 'countdown-track' }, h('span', { class: 'countdown-fill' })),
  );
}

export const FINAL_SECS = 5;

export function finalSeconds(onFinal, last = FINAL_SECS) {
  let key = null;
  let prev = null;
  return (ends, secs) => {
    if (ends !== key) {
      key = ends;
      prev = secs;
      return false;
    }
    if (secs === prev) return false;
    prev = secs;
    if (secs < 1 || secs > last) return false;
    try {
      onFinal(secs);
    } catch {
      return false;
    }
    return true;
  };
}

export function tickCountdowns(root, now, hooks = null) {
  const watch = hooks && typeof hooks.countdown === 'function' ? hooks.countdown : null;
  let first = true;
  for (const el of root.querySelectorAll('.countdown')) {
    const starts = Number(el.dataset.starts);
    const ends = Number(el.dataset.ends);
    if (!ends) continue;
    const span = Math.max(1, ends - starts);
    const left = Math.min(1, Math.max(0, (ends - now) / span));
    el.style.setProperty('--left', left.toFixed(4));
    const num = el.querySelector('.countdown-num');
    const text = clock(ends - now);
    if (num && num.textContent !== text) num.textContent = text;
    el.classList.toggle('is-low', ends - now <= 10000);
    if (watch && first) watch(ends, secondsLeft(ends, now));
    first = false;
  }
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function secondsLeft(ends, now) {
  return Math.max(0, Math.ceil((ends - now) / 1000));
}

export function timer(starts, ends, label) {
  return h(
    'div',
    { class: 'timer', dataset: { starts, ends }, attrs: { role: 'timer', 'aria-label': label || 'Time left' } },
    h('div', { class: 'timer-track' }, h('div', { class: 'timer-fill' })),
    h('span', { class: 'timer-num', text: '' }),
  );
}

export function tickTimers(root, now, hooks = null) {
  tickCountdowns(root, now, hooks);
  const watch = hooks && typeof hooks.timer === 'function' ? hooks.timer : null;
  let first = true;
  for (const el of root.querySelectorAll('.timer')) {
    const starts = Number(el.dataset.starts);
    const ends = Number(el.dataset.ends);
    if (!ends) continue;
    const span = Math.max(1, ends - starts);
    const left = Math.min(1, Math.max(0, (ends - now) / span));
    el.style.setProperty('--left', left.toFixed(4));
    const secs = secondsLeft(ends, now);
    const num = el.querySelector('.timer-num');
    const text = String(secs);
    if (num && num.textContent !== text) num.textContent = text;
    el.classList.toggle('is-low', secs <= 5 && secs > 0);
    el.classList.toggle('is-done', secs === 0);
    if (watch && first) watch(ends, secs);
    first = false;
  }
}
