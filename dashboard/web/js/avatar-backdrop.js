export const LOOKS_API = '/api/avatars/looks';
export const LOOKS_MAX = 40;
export const LOOKS_WAIT_MS = 30;
export const BACKDROP_CLASSES = Object.freeze(['av-cut', 'av-cut-clear', 'av-ring']);
export const BACKDROP_VARS = Object.freeze(['--av-bd-1', '--av-bd-2', '--av-bd-3', '--av-ring']);

const OWN_RE = /^\/avatar-img\/(a-[a-z0-9]{10})-[0-9a-f]{16}(?:-still)?\.(?:png|webp|jpg|gif)$/;
const ID_RE = /^a-[a-z0-9]{10}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;

const infos = new Map();
const primed = new Map();
const live = new Map();
const queued = new Set();
let timer = null;
let fetcher = null;

export function avatarIdOf(src) {
  if (typeof src !== 'string' || !src) return null;
  let path = src;
  if (!src.startsWith('/')) {
    try {
      const here = typeof location === 'object' && location && typeof location.origin === 'string' ? location.origin : null;
      const u = new URL(src);
      if (!here || u.origin !== here || u.search || u.hash) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const m = OWN_RE.exec(path);
  return m ? m[1] : null;
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function midHex(a, b) {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return `#${x.map((v, i) => Math.round((v + y[i]) / 2).toString(16).padStart(2, '0')).join('')}`;
}

export function cleanColours(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stops = Array.isArray(raw.stops) ? raw.stops.filter((s) => typeof s === 'string' && HEX_RE.test(s)).slice(0, 3) : [];
  if (stops.length < 2 || stops.length !== Math.min(3, Array.isArray(raw.stops) ? raw.stops.length : 0)) return null;
  const ring = typeof raw.ring === 'string' && HEX_RE.test(raw.ring) ? raw.ring : stops[0];
  return { stops: stops.length === 3 ? [stops[0], stops[2], stops[1]] : [stops[0], stops[1], midHex(stops[0], stops[1])], ring };
}

export function cleanInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cut = raw.cut === true;
  const moving = !cut && raw.moving === true;
  if (!cut && !moving) return null;
  return { cut, moving, clear: cut && raw.clear === true, colours: cleanColours(raw) };
}

export function paintBackdrop(el, info, colours = null) {
  if (!el || !el.classList || !el.style) return false;
  for (const c of BACKDROP_CLASSES) el.classList.remove(c);
  for (const v of BACKDROP_VARS) el.style.removeProperty(v);
  const shown = info && (info.cut || info.moving) ? info : null;
  const paint = colours || (shown && shown.colours) || null;
  if (!shown || !paint) return false;
  if (shown.cut) {
    el.classList.add('av-cut');
    if (shown.clear) el.classList.add('av-cut-clear');
  } else el.classList.add('av-ring');
  el.style.setProperty('--av-bd-1', paint.stops[0]);
  el.style.setProperty('--av-bd-2', paint.stops[1]);
  el.style.setProperty('--av-bd-3', paint.stops[2]);
  el.style.setProperty('--av-ring', paint.ring);
  return true;
}

function track(id, el, onUse) {
  let set = live.get(id);
  if (!set) live.set(id, (set = new Set()));
  const entry = { ref: typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el }, onUse: typeof onUse === 'function' ? onUse : null, seen: false };
  set.add(entry);
  return entry;
}

function apply(id) {
  const set = live.get(id);
  if (!set) return 0;
  const info = infos.get(id) || null;
  const colours = primed.get(id) || null;
  let n = 0;
  for (const entry of [...set]) {
    const el = entry.ref.deref();
    if (!el || (entry.seen && el.isConnected === false)) {
      set.delete(entry);
      continue;
    }
    if (el.isConnected) entry.seen = true;
    if (paintBackdrop(el, info, colours)) {
      n += 1;
      if (entry.onUse) {
        try {
          entry.onUse();
        } catch {}
      }
    }
  }
  if (!set.size) live.delete(id);
  return n;
}

function defaultFetch() {
  if (fetcher) return fetcher;
  if (typeof fetch !== 'function' || typeof location !== 'object' || !location || !/^https?:$/.test(String(location.protocol))) return null;
  return (url) => fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
}

async function flush() {
  timer = null;
  const doFetch = defaultFetch();
  const ids = [...queued].sort();
  queued.clear();
  if (!doFetch || !ids.length) return;
  for (let i = 0; i < ids.length; i += LOOKS_MAX) {
    const part = ids.slice(i, i + LOOKS_MAX);
    let looks = {};
    try {
      const res = await doFetch(`${LOOKS_API}?ids=${part.join(',')}`);
      const data = res && res.ok ? await res.json() : null;
      looks = data && data.looks && typeof data.looks === 'object' ? data.looks : {};
    } catch {
      looks = {};
    }
    for (const id of part) {
      if (!infos.has(id) || infos.get(id) === undefined) infos.set(id, cleanInfo(Object.prototype.hasOwnProperty.call(looks, id) ? looks[id] : null));
      apply(id);
    }
  }
}

function ask(id) {
  if (infos.has(id) || queued.has(id)) return;
  if (!defaultFetch()) return;
  queued.add(id);
  if (!timer) timer = setTimeout(flush, LOOKS_WAIT_MS);
}

export function backdropFor(el, src, onUse = null) {
  const id = avatarIdOf(src);
  if (!id || !el) return false;
  track(id, el, onUse);
  if (infos.has(id)) apply(id);
  else ask(id);
  return true;
}

export function primeBackdrop(src, colours) {
  const id = avatarIdOf(src);
  if (!id) return false;
  const clean = cleanColours(colours);
  if (clean) primed.set(id, clean);
  else primed.delete(id);
  apply(id);
  return Boolean(clean);
}

export function noteBackdrop(src, info) {
  const id = avatarIdOf(src);
  if (!id) return false;
  infos.set(id, cleanInfo(info));
  queued.delete(id);
  apply(id);
  return true;
}

export function backdropState(src) {
  const id = avatarIdOf(src);
  return id ? { info: infos.has(id) ? infos.get(id) : undefined, colours: primed.get(id) || null } : null;
}

export function setBackdropFetch(fn) {
  fetcher = typeof fn === 'function' ? fn : null;
}

export function flushBackdrops() {
  if (timer) clearTimeout(timer);
  return flush();
}

export function resetBackdrops() {
  if (timer) clearTimeout(timer);
  timer = null;
  infos.clear();
  primed.clear();
  live.clear();
  queued.clear();
  fetcher = null;
}

export function isAvatarLookId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}
