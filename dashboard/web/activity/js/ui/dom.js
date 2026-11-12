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

export function avatar(p, size = 'md') {
  const wrap = h('span', { class: ['avatar', `avatar-${size}`], vars: { '--hue': p.hue ?? 20 }, attrs: { 'aria-hidden': 'true' } });
  if (p.avatar) {
    const img = h('img', { src: p.avatar, alt: '', attrs: { loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' } });
    img.addEventListener('error', () => {
      img.remove();
      wrap.textContent = p.initials || '?';
    });
    wrap.append(img);
  } else {
    wrap.textContent = p.initials || '?';
  }
  return wrap;
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

export function tickTimers(root, now) {
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
  }
}
