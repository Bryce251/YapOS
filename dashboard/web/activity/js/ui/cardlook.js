import { fxLevel, sharedLoop } from './fxmode.js';

export const CARD_SHEET = '/activity/css/profilecard-look.css';
export const FX_MODULE = '../../../js/profile-fx.js';
export const THEME_KEYS = Object.freeze(['bg', 'bg2', 'glow', 'surface', 'surface2', 'surface3', 'border', 'borderStrong', 'text', 'text2', 'text3', 'accent', 'accentHover', 'onAccent', 'accentText', 'accentSoft']);
export const THEME_IDS = Object.freeze(['midnight', 'sakura', 'ocean', 'forest', 'sunset', 'candy', 'mono', 'neon', 'aurora', 'ember', 'frost', 'royal', 'custom']);
export const THEME_MODES = Object.freeze(['auto', 'dark', 'light']);
export const THEME_PATTERNS = Object.freeze(['glow', 'dots', 'grid', 'waves', 'stars', 'plain']);
export const EFFECT_IDS = Object.freeze(['none', 'snow', 'snowflakes', 'sakura', 'stars', 'fireflies', 'confetti', 'hearts', 'bubbles', 'rain', 'embers', 'sparkles']);
export const FEATURED_IDS = Object.freeze(['level', 'wins', 'games', 'winrate', 'badges', 'shards']);
export const CROP_ZOOM_MAX = 8;
export const BANNER_RATIO = 3;
export const BANNER_STILL_RE = /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}-still\.(png|webp|jpg)$/;
export const NAME_GRADIENTS = Object.freeze({
  sunset: Object.freeze({ dark: ['#ff9a6b', '#ff6f91', '#ffc46b'], light: ['#c2410c', '#be185d', '#b45309'] }),
  ocean: Object.freeze({ dark: ['#6bd3ff', '#8ab0ff', '#5ce1c8'], light: ['#0369a1', '#1d4ed8', '#0f766e'] }),
  aurora: Object.freeze({ dark: ['#7cf0b5', '#8ab4ff', '#d39bff'], light: ['#047857', '#4338ca', '#7e22ce'] }),
  candy: Object.freeze({ dark: ['#ff8fd1', '#c59bff', '#8fd3ff'], light: ['#be185d', '#7e22ce', '#0369a1'] }),
  forest: Object.freeze({ dark: ['#8ee08a', '#4fd1a5', '#c6e36b'], light: ['#166534', '#047857', '#4d7c0f'] }),
  gold: Object.freeze({ dark: ['#ffd66b', '#ffb547', '#fff0a8'], light: ['#92400e', '#b45309', '#854d0e'] }),
});
export const THEME_TOKENS = Object.freeze([
  ['--bg', 'bg'],
  ['--pt-bg', 'bg'],
  ['--pt-bg2', 'bg2'],
  ['--pt-glow', 'glow'],
  ['--surface', 'surface'],
  ['--surface-2', 'surface2'],
  ['--surface-3', 'surface3'],
  ['--surface-float', 'surface3'],
  ['--bar-zero', 'surface3'],
  ['--border', 'border'],
  ['--border-strong', 'borderStrong'],
  ['--accent-line', 'borderStrong'],
  ['--text', 'text'],
  ['--text-2', 'text2'],
  ['--text-3', 'text3'],
  ['--accent', 'accent'],
  ['--accent-hover', 'accentHover'],
  ['--on-accent', 'onAccent'],
  ['--accent-text', 'accentText'],
  ['--accent-soft', 'accentSoft'],
  ['--focus', 'accentText'],
  ['--pc-ac', 'accent'],
  ['--pc-ac-text', 'accentText'],
]);
const THEME_CLASSES = ['has-theme', 'is-light', ...THEME_PATTERNS.map((p) => `pat-${p}`)];
const HEX_RE = /^#[0-9a-f]{6}$/;

function own(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

export function pick(list, value, fallback = null) {
  return typeof value === 'string' && list.includes(value) ? value : fallback;
}

export function cleanPalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shades = (s) => {
    if (!s || typeof s !== 'object') return null;
    const out = {};
    for (const k of THEME_KEYS) {
      if (typeof s[k] !== 'string' || !HEX_RE.test(s[k])) return null;
      out[k] = s[k];
    }
    return out;
  };
  const light = shades(raw.light);
  const dark = shades(raw.dark);
  if (!light || !dark || !THEME_IDS.includes(raw.id)) return null;
  return { id: raw.id, mode: pick(THEME_MODES, raw.mode, 'auto'), pattern: pick(THEME_PATTERNS, raw.pattern, 'glow'), light, dark };
}

export function readMotion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const still = typeof raw.still === 'string' && BANNER_STILL_RE.test(raw.still) ? raw.still : null;
  const w = Number(raw.width);
  const ht = Number(raw.height);
  if (!still || !Number.isInteger(w) || !Number.isInteger(ht) || w < 1 || ht < 1 || w > 10000 || ht > 10000) return null;
  return { still, width: w, height: ht };
}

function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function readCrop(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return { zoom: Math.min(CROP_ZOOM_MAX, Math.max(1, fin(c.zoom, 1))), x: Math.min(1, Math.max(0, fin(c.x, 0.5))), y: Math.min(1, Math.max(0, fin(c.y, 0.5))) };
}

function whole(v) {
  return Math.max(1, Math.floor(Number(v) || 1));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function cropBox(width, height, crop) {
  const w = whole(width);
  const ht = whole(height);
  const c = readCrop(crop);
  const cover = w / ht > BANNER_RATIO ? ht * BANNER_RATIO : w;
  const sw = cover / c.zoom;
  const sh = sw / BANNER_RATIO;
  const cx = Math.min(w - sw / 2, Math.max(sw / 2, c.x * w));
  const cy = Math.min(ht - sh / 2, Math.max(sh / 2, c.y * ht));
  return { width: round4((w / sw) * 100), height: round4((ht / sh) * 100), left: round4((-(cx - sw / 2) / sw) * 100) + 0, top: round4((-(cy - sh / 2) / sh) * 100) + 0 };
}

export function themeOf(palette) {
  if (!palette) return null;
  const light = palette.mode === 'light';
  const shades = light ? palette.light : palette.dark;
  const vars = {};
  for (const [token, key] of THEME_TOKENS) vars[token] = shades[key];
  return { id: palette.id, light, pattern: palette.pattern, vars };
}

export function paintTheme(el, theme) {
  if (!el || !el.style || !el.classList) return false;
  for (const [token] of THEME_TOKENS) el.style.removeProperty(token);
  for (const c of THEME_CLASSES) el.classList.remove(c);
  if (!theme) return false;
  for (const [token, value] of Object.entries(theme.vars)) el.style.setProperty(token, value);
  el.classList.add('has-theme', `pat-${theme.pattern}`);
  if (theme.light) el.classList.add('is-light');
  return true;
}

export function gradientOf(id, light = false) {
  if (!own(NAME_GRADIENTS, id)) return null;
  const stops = NAME_GRADIENTS[id][light ? 'light' : 'dark'];
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function reducedOf(win) {
  try {
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function motionOk(win) {
  return fxLevel() === 'full' && !reducedOf(win);
}

export function ensureSheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  const found = typeof doc.querySelector === 'function' ? doc.querySelector('link[data-pcard-look]') : null;
  if (found) return true;
  const host = doc.head || doc.body;
  if (!host) return false;
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', CARD_SHEET);
  link.setAttribute('data-pcard-look', '');
  host.append(link);
  return true;
}

function loopWin(win) {
  const loop = sharedLoop();
  return {
    get devicePixelRatio() {
      return win.devicePixelRatio;
    },
    get innerWidth() {
      return win.innerWidth;
    },
    get innerHeight() {
      return win.innerHeight;
    },
    matchMedia: (q) => (typeof win.matchMedia === 'function' ? win.matchMedia(q) : null),
    addEventListener: (...a) => (typeof win.addEventListener === 'function' ? win.addEventListener(...a) : undefined),
    removeEventListener: (...a) => (typeof win.removeEventListener === 'function' ? win.removeEventListener(...a) : undefined),
    requestAnimationFrame: (fn) => loop.add((ts) => {
      fn(ts);
      return false;
    }),
    cancelAnimationFrame: (off) => {
      if (typeof off === 'function') off();
    },
  };
}

const PIN_STYLE = Object.freeze([['position', 'absolute'], ['inset', '0'], ['width', '100%'], ['height', '100%'], ['pointer-events', 'none']]);

export function createCardFx({ win = globalThis.window, doc = globalThis.document, load = () => import(FX_MODULE) } = {}) {
  let handle = null;
  let current = null;
  let token = 0;
  let mod = null;

  function module() {
    if (!mod) mod = Promise.resolve().then(load).catch(() => {
      mod = null;
      return null;
    });
    return mod;
  }

  function stop() {
    token += 1;
    current = null;
    if (handle) handle.stop();
    handle = null;
  }

  async function start(host, id) {
    if (current && current.host === host && current.id === id) return Boolean(handle && handle.running);
    stop();
    if (!host || !win || !doc || pick(EFFECT_IDS, id, 'none') === 'none' || !motionOk(win)) return false;
    const mine = token;
    current = { host, id };
    const m = await module();
    if (mine !== token || !m || typeof m.startEffect !== 'function') return false;
    if (!m.effectsAllowed() || m.prefersReducedMotion(win)) return false;
    const size = () => {
      const r = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
      return { width: (r && r.width) || host.clientWidth || 0, height: (r && r.height) || host.clientHeight || 0 };
    };
    handle = m.startEffect(host, id, { win: loopWin(win), doc, className: 'pcard-fx', box: size });
    if (handle.canvas && handle.canvas.style) for (const [k, v] of PIN_STYLE) handle.canvas.style.setProperty(k, v);
    return Boolean(handle.running);
  }

  return {
    start,
    stop,
    get running() {
      return Boolean(handle && handle.running);
    },
    get effect() {
      return current ? current.id : null;
    },
  };
}
