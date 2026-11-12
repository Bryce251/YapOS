import { h } from './dom.js';
import { icon } from './icons.js';

const KEY = 'yapos-theme';
const listeners = new Set();

function stored() {
  try {
    const t = window.localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : '';
  } catch {
    return '';
  }
}

export function effectiveTheme() {
  const s = document.documentElement.getAttribute('data-theme') || stored();
  if (s === 'light' || s === 'dark') return s;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    document.documentElement.setAttribute('data-theme', theme);
  }
  return applyListeners();
}

function applyListeners() {
  const t = effectiveTheme();
  for (const fn of Array.from(listeners)) fn(t);
  return t;
}

export function initTheme() {
  const s = stored();
  if (s) document.documentElement.setAttribute('data-theme', s);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!stored()) applyListeners();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
}

export function themeToggle() {
  const btn = h('button', { type: 'button', class: 'icon-btn theme-toggle' });
  const render = (t) => {
    if (listeners.has(render) && !btn.isConnected) {
      listeners.delete(render);
      return;
    }
    btn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon', { size: 18 }));
    const label = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  render(effectiveTheme());
  btn.addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
  listeners.add(render);
  return btn;
}
