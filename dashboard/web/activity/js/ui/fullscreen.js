import { h } from './dom.js';

export const FOCUS_KEY = 'yapos-party-focus';
export const FOCUS_CLASS = 'is-focus';
export const FULL_CLASS = 'is-full';
export const FOCUS_TOAST = "Full screen isn't available here, so we've hidden everything but the game.";
export const FULL_WAIT_MS = 1200;
export const ENTER_LABEL = 'Full screen';
export const EXIT_LABEL = 'Exit full screen';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ENTER_PATH = 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5';
const EXIT_PATH = 'M9 4v5H4M15 4v5h5M15 20v-5h5M9 20v-5H4';

export function screenApi(doc) {
  const d = doc || null;
  const el = d ? d.documentElement || null : null;
  const request = el ? el.requestFullscreen || el.webkitRequestFullscreen || null : null;
  const exit = d ? d.exitFullscreen || d.webkitExitFullscreen || null : null;
  const enabled = Boolean(d && (d.fullscreenEnabled || d.webkitFullscreenEnabled) && typeof request === 'function');
  return {
    enabled,
    current() {
      if (!d) return null;
      return d.fullscreenElement || d.webkitFullscreenElement || null;
    },
    request() {
      return request.call(el);
    },
    exit() {
      if (typeof exit !== 'function') return null;
      return exit.call(d);
    },
  };
}

export function isTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = typeof target.localName === 'string' ? target.localName : String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function screenKey(e) {
  if (!e || e.defaultPrevented) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = String(e.key || '');
  if (k === 'Escape' || k === 'Esc') return 'leave';
  if ((k === 'f' || k === 'F') && !e.repeat && !isTyping(e.target)) return 'toggle';
  return null;
}

function store(win) {
  try {
    return win && win.localStorage ? win.localStorage : null;
  } catch {
    return null;
  }
}

export function readFocus(win) {
  const s = store(win);
  if (!s) return false;
  try {
    return s.getItem(FOCUS_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveFocus(win, on) {
  const s = store(win);
  if (!s) return false;
  try {
    s.setItem(FOCUS_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function screenIcon(on) {
  const svg = svgEl('svg', { class: 'btn-screen-icon', viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgEl('path', { d: on ? EXIT_PATH : ENTER_PATH, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

export function screenButton(mode, onClick) {
  const on = mode === 'full' || mode === 'focus';
  const label = on ? EXIT_LABEL : ENTER_LABEL;
  return h(
    'button',
    {
      class: ['btn', 'btn-ghost', 'btn-sm', 'btn-screen', on ? 'is-on' : null, 'spot'],
      type: 'button',
      dataset: { key: 'screen', mode },
      attrs: { 'aria-label': label, title: `${label} (F)`, 'aria-keyshortcuts': on ? 'F Escape' : 'F' },
      on: { click: onClick },
    },
    screenIcon(on),
  );
}

export function createFullscreen({ root, win, doc = typeof document !== 'undefined' ? document : null, toast = () => {}, onChange = () => {} }) {
  const api = screenApi(doc);
  let mode = api.current() ? 'full' : readFocus(win) ? 'focus' : 'off';
  let told = false;
  let waiting = null;
  let destroyed = false;

  function paint() {
    if (!root || !root.classList) return;
    root.classList.toggle(FOCUS_CLASS, mode !== 'off');
    root.classList.toggle(FULL_CLASS, mode === 'full');
  }

  function set(next) {
    if (destroyed || next === mode) return;
    mode = next;
    paint();
    onChange(mode);
  }

  function clearWait() {
    if (waiting !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(waiting);
    waiting = null;
  }

  function focusMode() {
    clearWait();
    saveFocus(win, true);
    set('focus');
    if (!told) {
      told = true;
      toast(FOCUS_TOAST);
    }
  }

  function enter() {
    if (destroyed || mode !== 'off') return mode;
    if (!api.enabled) {
      focusMode();
      return mode;
    }
    let result;
    try {
      result = api.request();
    } catch {
      focusMode();
      return mode;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          if (destroyed) return;
          if (api.current()) set('full');
          else focusMode();
        },
        () => {
          if (!destroyed && mode === 'off') focusMode();
        },
      );
      return mode;
    }
    if (win && typeof win.setTimeout === 'function') {
      clearWait();
      waiting = win.setTimeout(() => {
        waiting = null;
        if (destroyed || mode !== 'off') return;
        if (api.current()) set('full');
        else focusMode();
      }, FULL_WAIT_MS);
    }
    return mode;
  }

  function leave() {
    if (destroyed) return mode;
    clearWait();
    if (mode === 'full') {
      try {
        const r = api.exit();
        if (r && typeof r.then === 'function') r.then(null, () => null);
      } catch {
        set('off');
      }
      if (!api.current()) set('off');
      return mode;
    }
    if (mode === 'focus') {
      saveFocus(win, false);
      set('off');
    }
    return mode;
  }

  function toggle() {
    return mode === 'off' ? enter() : leave();
  }

  function onScreenChange() {
    if (destroyed) return;
    clearWait();
    if (api.current()) set('full');
    else if (mode === 'full') set('off');
  }

  function onKey(e) {
    const act = screenKey(e);
    if (!act) return;
    if (act === 'leave') {
      if (mode === 'focus') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        leave();
      }
      return;
    }
    const later = () => {
      if (!e.defaultPrevented) toggle();
    };
    if (win && typeof win.setTimeout === 'function') win.setTimeout(later, 0);
    else later();
  }

  const events = ['fullscreenchange', 'webkitfullscreenchange'];
  if (doc && typeof doc.addEventListener === 'function') for (const ev of events) doc.addEventListener(ev, onScreenChange);
  if (win && typeof win.addEventListener === 'function') win.addEventListener('keydown', onKey);
  paint();

  return {
    get mode() {
      return mode;
    },
    get on() {
      return mode !== 'off';
    },
    enter,
    leave,
    toggle,
    onKey,
    button: () => screenButton(mode, toggle),
    destroy() {
      destroyed = true;
      clearWait();
      if (doc && typeof doc.removeEventListener === 'function') for (const ev of events) doc.removeEventListener(ev, onScreenChange);
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('keydown', onKey);
      if (root && root.classList) {
        root.classList.remove(FOCUS_CLASS);
        root.classList.remove(FULL_CLASS);
      }
    },
  };
}
