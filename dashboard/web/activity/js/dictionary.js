const SOURCE = new URL('../data/words.txt', import.meta.url).href;

let text = '';
let starts = new Uint32Array(0);
let pending = null;
let source = null;

export let ready = false;
export let failed = false;
export let size = 0;

function fetchWords() {
  if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
  return fetch(SOURCE, { credentials: 'same-origin' }).then((res) => {
    if (!res.ok) throw new Error(`words ${res.status}`);
    return res.text();
  });
}

function index(raw) {
  const offsets = [];
  let at = 0;
  while (at < raw.length) {
    const end = raw.indexOf('\n', at);
    const stop = end < 0 ? raw.length : end;
    if (stop > at) offsets.push(at);
    at = stop + 1;
  }
  return Uint32Array.from(offsets);
}

function wordAt(i) {
  const s = starts[i];
  const e = text.indexOf('\n', s);
  return text.slice(s, e < 0 ? text.length : e);
}

function sortedNow() {
  for (let i = 1; i < starts.length; i += 1) if (wordAt(i - 1) >= wordAt(i)) return false;
  return true;
}

export function useText(raw) {
  const clean = String(raw ?? '').toLowerCase().replace(/\r/g, '');
  text = clean;
  starts = index(clean);
  if (!sortedNow()) {
    const list = [...new Set(clean.split('\n').filter((w) => /^[a-z]+$/.test(w)))].sort();
    text = list.join('\n');
    starts = index(text);
  }
  size = starts.length;
  ready = size > 0;
  if (ready) failed = false;
  return ready;
}

function announce() {
  const w = typeof window !== 'undefined' ? window : null;
  if (!w || typeof w.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  try {
    w.dispatchEvent(new CustomEvent('yapos:dictionary', { detail: { ready, failed } }));
  } catch {
    return;
  }
}

export function load(fetcher) {
  if (typeof fetcher === 'function') source = fetcher;
  if (ready) return Promise.resolve(true);
  if (pending) return pending;
  const get = source || fetchWords;
  pending = Promise.resolve()
    .then(get)
    .then((raw) => {
      if (!useText(raw)) throw new Error('empty word list');
      return true;
    })
    .catch(() => {
      failed = true;
      return false;
    })
    .then((ok) => {
      pending = null;
      announce();
      return ok;
    });
  return pending;
}

export function loading() {
  return pending !== null;
}

export function isWord(word) {
  if (!ready) return false;
  const w = String(word ?? '').toLowerCase();
  if (!w) return false;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const here = wordAt(mid);
    if (here === w) return true;
    if (here < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export function reset() {
  text = '';
  starts = new Uint32Array(0);
  pending = null;
  source = null;
  ready = false;
  failed = false;
  size = 0;
}
