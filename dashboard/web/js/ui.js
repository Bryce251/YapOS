import { h, nextId, replace, trapFocus, focusFirst } from './dom.js';
import { icon } from './icons.js';
import { hueFrom, initials, safeImageUrl } from './format.js';
import { OFFLINE_MESSAGE, SLOW_AFTER_MS } from './api.js';

export function avatar({ name = '', url = '', id = '', size = 'md', shape = 'circle' } = {}) {
  const el = h('span', { class: ['avatar', `avatar-${size}`, shape === 'square' ? 'avatar-square' : ''], attrs: { 'aria-hidden': 'true' } });
  el.style.setProperty('--avatar-hue', String(hueFrom(id || name)));
  const fallback = h('span', { class: 'avatar-initials', text: initials(name) });
  el.appendChild(fallback);
  const src = safeImageUrl(url);
  if (src) {
    const img = h('img', { alt: '', src, loading: 'lazy', decoding: 'async', attrs: { referrerpolicy: 'no-referrer' } });
    img.addEventListener('load', () => el.classList.add('has-image'));
    img.addEventListener('error', () => img.remove());
    el.appendChild(img);
  }
  return el;
}

export function button({ label = '', icon: iconName = '', variant = 'secondary', size = 'md', onClick, type = 'button', ariaLabel = '', disabled = false, iconRight = '', className = '' } = {}) {
  const btn = h('button', {
    type,
    class: ['btn', `btn-${variant}`, size !== 'md' ? `btn-${size}` : '', !label ? 'btn-icon-only' : '', className],
    disabled,
    attrs: { 'aria-label': ariaLabel || null },
    on: { click: onClick },
  },
  iconName ? icon(iconName, { size: size === 'sm' ? 14 : 16 }) : null,
  label ? h('span', { class: 'btn-label', text: label }) : null,
  iconRight ? icon(iconRight, { size: size === 'sm' ? 14 : 16 }) : null);
  return btn;
}

export function linkButton({ label, href, icon: iconName = '', variant = 'secondary', size = 'md', external = false, iconRight = '', className = '' }) {
  return h('a', {
    href,
    class: ['btn', `btn-${variant}`, size !== 'md' ? `btn-${size}` : '', className],
    target: external ? '_blank' : null,
    rel: external ? 'noopener noreferrer' : null,
    dataset: external ? null : { link: '' },
  },
  iconName ? icon(iconName, { size: size === 'sm' ? 14 : 16 }) : null,
  h('span', { class: 'btn-label', text: label }),
  iconRight ? icon(iconRight, { size: size === 'sm' ? 14 : 16 }) : null);
}

export function setBusy(btn, busy, busyLabel) {
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  const label = btn.querySelector('.btn-label');
  if (label) {
    if (busy && busyLabel) {
      label.dataset.idle = label.textContent;
      label.textContent = busyLabel;
    } else if (!busy && label.dataset.idle) {
      label.textContent = label.dataset.idle;
      delete label.dataset.idle;
    }
  }
}

export function switchControl({ checked = false, label = '', disabled = false, onChange, id } = {}) {
  const btn = h('button', {
    type: 'button',
    class: 'switch',
    id: id || null,
    disabled,
    attrs: { role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label || null },
  }, h('span', { class: 'switch-thumb' }));
  const api = {
    el: btn,
    get checked() {
      return btn.getAttribute('aria-checked') === 'true';
    },
    set(value) {
      btn.setAttribute('aria-checked', value ? 'true' : 'false');
    },
    setDisabled(value) {
      btn.disabled = value;
    },
    setBusy(value) {
      btn.classList.toggle('is-busy', value);
      btn.setAttribute('aria-busy', value ? 'true' : 'false');
    },
  };
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const next = !api.checked;
    api.set(next);
    onChange?.(next, api);
  });
  return api;
}

export function badge(text, tone = 'neutral', iconName = '') {
  return h('span', { class: ['badge', `badge-${tone}`] }, iconName ? icon(iconName, { size: 12 }) : null, h('span', { text }));
}

export function dot(tone = 'neutral', label = '') {
  return h('span', { class: ['status-dot', `status-${tone}`], attrs: { role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true' } });
}

export function skeleton(className = '') {
  return h('span', { class: ['skeleton', className], attrs: { 'aria-hidden': 'true' } });
}

export function skeletonBlock(lines = 3, className = '') {
  const wrap = h('div', { class: ['skeleton-block', className], attrs: { 'aria-hidden': 'true' } });
  for (let i = 0; i < lines; i++) wrap.appendChild(skeleton(i === lines - 1 ? 'skeleton-line skeleton-line-short' : 'skeleton-line'));
  return wrap;
}

export function loadingRegion(label, ...children) {
  return h('div', { class: 'loading-region', attrs: { 'aria-busy': 'true' } }, h('span', { class: 'sr-only', attrs: { role: 'status' }, text: label || 'Loading' }), ...children);
}

export function emptyState({ icon: iconName = 'inbox', title, body = '', action = null, compact = false }) {
  return h('div', { class: ['empty-state', compact ? 'empty-compact' : ''] },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 20 })),
    h('h3', { class: 'empty-title', text: title }),
    body ? h('p', { class: 'empty-body', text: body }) : null,
    action ? h('div', { class: 'empty-action' }, action) : null);
}

export function errorState({ title = 'Something went wrong', body = '', onRetry, compact = false, iconName = 'alert' }) {
  return h('div', { class: ['empty-state', 'error-state', compact ? 'empty-compact' : ''], attrs: { role: 'alert' } },
    h('div', { class: 'empty-icon empty-icon-danger' }, icon(iconName, { size: 20 })),
    h('h3', { class: 'empty-title', text: title }),
    body ? h('p', { class: 'empty-body', text: body }) : null,
    onRetry ? h('div', { class: 'empty-action' }, button({ label: 'Try again', icon: 'refresh', onClick: onRetry })) : null);
}

export function pendingState({ onRetry, compact = false, label = 'Waiting for YapOS…', hint = 'Your request is on its way to the bot.' } = {}) {
  const title = h('h3', { class: 'empty-title', text: label });
  const body = h('p', { class: 'empty-body', text: hint });
  const action = h('div', { class: 'empty-action' });
  const iconWrap = h('div', { class: 'empty-icon pending-icon' }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }));
  const el = h('div', { class: ['empty-state', 'pending-state', compact ? 'empty-compact' : ''], attrs: { role: 'status', 'aria-live': 'polite' } }, iconWrap, title, body, action);
  const timer = setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.add('is-slow');
    replace(iconWrap, icon('signal-off', { size: 20 }));
    title.textContent = "YapOS hasn't answered yet";
    body.textContent = 'It may be offline or restarting. Your request is still waiting and will finish on its own if YapOS comes back.';
    if (onRetry) replace(action, button({ label: 'Retry', icon: 'refresh', onClick: onRetry }));
  }, SLOW_AFTER_MS);
  return { el, stop: () => clearTimeout(timer) };
}

export function offlineState({ onRetry, compact = false } = {}) {
  return errorState({ title: "YapOS hasn't answered", body: OFFLINE_MESSAGE, onRetry, compact, iconName: 'signal-off' });
}

let toastRoot = null;
export function toast(message, { tone = 'success', timeout = 4000, title = '' } = {}) {
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = h('div', { class: 'toast-root', attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' } });
    document.body.appendChild(toastRoot);
  }
  const iconName = tone === 'success' ? 'check' : tone === 'danger' ? 'alert' : 'info';
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  };
  const el = h('div', { class: ['toast', `toast-${tone}`], attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
    h('span', { class: 'toast-icon' }, icon(iconName, { size: 16 })),
    h('div', { class: 'toast-text' }, title ? h('strong', { text: title }) : null, h('span', { text: message })),
    h('button', { type: 'button', class: 'icon-btn icon-btn-sm', attrs: { 'aria-label': 'Dismiss' }, on: { click: close } }, icon('x', { size: 14 })));
  toastRoot.appendChild(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return fallbackCopy(text);
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = h('textarea', { value: text, class: 'sr-only', readOnly: true, attrs: { 'aria-hidden': 'true' } });
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function copyButton({ getText, label = 'Copy link', copiedLabel = 'Copied', variant = 'secondary', size = 'md' }) {
  const btn = button({ label, icon: 'link', variant, size });
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    const lbl = btn.querySelector('.btn-label');
    if (ok) {
      btn.classList.add('is-copied');
      btn.replaceChild(icon('check', { size: size === 'sm' ? 14 : 16 }), btn.firstChild);
      if (lbl) lbl.textContent = copiedLabel;
      toast('Link copied to your clipboard.');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('is-copied');
        btn.replaceChild(icon('link', { size: size === 'sm' ? 14 : 16 }), btn.firstChild);
        if (lbl) lbl.textContent = label;
      }, 1800);
    } else {
      toast("Couldn't copy automatically. Copy the address from your browser bar.", { tone: 'danger' });
    }
  });
  return btn;
}

export function drawer({ title, subtitle = '', onClose, labelledBy } = {}) {
  const titleId = labelledBy || nextId('drawer-title');
  const body = h('div', { class: 'drawer-body' });
  const previous = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', attrs: { 'aria-label': 'Close panel' } }, icon('x', { size: 18 }));
  const header = h('div', { class: 'drawer-header' },
    h('div', { class: 'drawer-titles' },
      h('h2', { class: 'drawer-title', id: titleId, text: title }),
      subtitle ? h('p', { class: 'drawer-subtitle', text: subtitle }) : null),
    closeBtn);
  const panel = h('div', { class: 'drawer-panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, tabIndex: -1 }, header, body);
  const overlay = h('div', { class: 'drawer-overlay' });
  const root = h('div', { class: 'drawer-root' }, overlay, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.classList.remove('is-open');
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('has-modal');
    setTimeout(() => root.remove(), 180);
    if (previous && previous.focus && previous.isConnected) previous.focus();
    onClose?.();
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else trapFocus(panel, e);
  }
  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(root);
  document.body.classList.add('has-modal');
  requestAnimationFrame(() => {
    root.classList.add('is-open');
    panel.focus();
  });
  return { root, body, close, setTitle: (t) => { header.querySelector('.drawer-title').textContent = t; } };
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    const titleId = nextId('dlg');
    const previous = document.activeElement;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      document.body.classList.remove('has-modal');
      if (previous && previous.focus && previous.isConnected) previous.focus();
      resolve(v);
    };
    const cancel = button({ label: 'Cancel', onClick: () => finish(false) });
    const ok = button({ label: confirmLabel, variant: tone === 'danger' ? 'danger' : 'primary', onClick: () => finish(true) });
    const panel = h('div', { class: 'dialog-panel', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { class: 'dialog-title', id: titleId, text: title }),
      body ? h('p', { class: 'dialog-body', text: body }) : null,
      h('div', { class: 'dialog-actions' }, cancel, ok));
    const root = h('div', { class: 'dialog-root' }, h('div', { class: 'dialog-overlay', on: { click: () => finish(false) } }), panel);
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else trapFocus(panel, e);
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    document.body.classList.add('has-modal');
    focusFirst(panel);
    ok.focus();
  });
}

export function card({ title = '', icon: iconName = '', actions = null, className = '', bodyClass = '' } = {}, ...children) {
  const head = title ? h('div', { class: 'card-header' },
    h('h2', { class: 'card-title' }, iconName ? icon(iconName, { size: 16 }) : null, h('span', { text: title })),
    actions ? h('div', { class: 'card-actions' }, actions) : null) : null;
  return h('section', { class: ['card', className] }, head, h('div', { class: ['card-body', bodyClass] }, ...children));
}

export function statCard({ label, value, icon: iconName = '', hint = '', tone = '' }) {
  return h('div', { class: ['stat-card', tone ? `stat-${tone}` : ''] },
    h('div', { class: 'stat-top' },
      h('span', { class: 'stat-label', text: label }),
      iconName ? h('span', { class: 'stat-icon' }, icon(iconName, { size: 16 })) : null),
    h('div', { class: 'stat-value', text: value }),
    hint ? h('div', { class: 'stat-hint', text: hint }) : h('div', { class: 'stat-hint', text: ' ' }));
}

export function statCardSkeleton() {
  return h('div', { class: 'stat-card', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'stat-top' }, skeleton('skeleton-text skeleton-w-40')),
    h('div', { class: 'stat-value' }, skeleton('skeleton-title skeleton-w-30')),
    h('div', { class: 'stat-hint' }, skeleton('skeleton-text skeleton-w-50')));
}

export function pageHeader({ title, description = '', actions = null, eyebrow = '' }) {
  return h('header', { class: 'page-header' },
    h('div', { class: 'page-heading' },
      eyebrow ? h('div', { class: 'page-eyebrow' }, eyebrow) : null,
      h('h1', { class: 'page-title', text: title }),
      description ? h('p', { class: 'page-description', text: description }) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function appGlyph(app, size = 'md') {
  const raw = typeof app?.icon === 'string' ? app.icon.trim() : '';
  const chars = Array.from(raw);
  const usable = raw && chars.length <= 4 && !/^[A-Za-z0-9_.]+$/.test(raw);
  const el = h('span', { class: ['app-glyph', `app-glyph-${size}`], attrs: { 'aria-hidden': 'true' } });
  el.style.setProperty('--glyph-hue', String(hueFrom(app?.id || app?.name || '')));
  if (usable) el.appendChild(h('span', { class: 'app-glyph-emoji', text: raw }));
  else el.appendChild(h('span', { class: 'app-glyph-letter', text: initials(app?.name || app?.id || '?').charAt(0) }));
  return el;
}
