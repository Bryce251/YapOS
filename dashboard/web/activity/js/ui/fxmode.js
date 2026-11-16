export const FX_PREFS = Object.freeze(['auto', 'full', 'lite']);
export const FX_LEVELS = Object.freeze(['full', 'lite', 'static']);
export const FX_STORE_KEY = 'yapos-party-fx';
export const LITE_CORES = 4;
export const LITE_MEMORY_GB = 4;
export const PROBE_DELAY_MS = 1200;
export const PROBE_FRAMES = 30;
export const PROBE_SLOW_MS = 26;
export const PARTICLE_CAP = 120;
export const LITE_PARTICLE_CAP = 30;
export const COUNT_MS = 650;

const LABELS = Object.freeze({ auto: 'Auto', full: 'Full', lite: 'Lite' });

export function liteHint(nav) {
  if (!nav || typeof nav !== 'object') return null;
  try {
    const conn = nav.connection;
    if (conn && conn.saveData === true) return 'save-data';
  } catch {
    return null;
  }
  const cores = Number(nav.hardwareConcurrency);
  if (Number.isFinite(cores) && cores > 0 && cores <= LITE_CORES) return 'cores';
  const mem = Number(nav.deviceMemory);
  if (Number.isFinite(mem) && mem > 0 && mem <= LITE_MEMORY_GB) return 'memory';
  return null;
}

export function probeSlow(deltas) {
  const list = (Array.isArray(deltas) ? deltas : []).filter((d) => Number.isFinite(d) && d > 0 && d < 1000);
  if (list.length < 8) return false;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const slowShare = list.filter((d) => d > 50).length / list.length;
  return mid > PROBE_SLOW_MS || slowShare > 0.2;
}

export function cleanPref(v) {
  return FX_PREFS.includes(v) ? v : 'auto';
}

export function resolveLevel({ pref = 'auto', reduced = false, hint = null, slow = false } = {}) {
  if (reduced) return 'static';
  const p = cleanPref(pref);
  if (p === 'full') return 'full';
  if (p === 'lite') return 'lite';
  return hint || slow ? 'lite' : 'full';
}

export function nextPref(pref) {
  const i = FX_PREFS.indexOf(cleanPref(pref));
  return FX_PREFS[(i + 1) % FX_PREFS.length];
}

export function fxButtonModel(pref, level) {
  const p = cleanPref(pref);
  const lvl = FX_LEVELS.includes(level) ? level : 'full';
  const shown = p === 'auto' ? `Auto (${LABELS[lvl === 'static' ? 'lite' : lvl]})` : LABELS[p];
  return {
    pref: p,
    level: lvl,
    icon: lvl === 'full' ? '✨' : '🌙',
    label: `Effects: ${shown}`,
    title: lvl === 'static' ? 'Effects are still because your device asks for reduced motion' : `Effects: ${shown}. Tap to switch to ${LABELS[nextPref(p)]}`,
    pressed: lvl === 'full',
  };
}

export function particleCap(level) {
  if (level === 'static') return 0;
  return level === 'lite' ? LITE_PARTICLE_CAP : PARTICLE_CAP;
}

function readStore(win) {
  try {
    return cleanPref(win.localStorage.getItem(FX_STORE_KEY));
  } catch {
    return 'auto';
  }
}

function writeStore(win, pref) {
  try {
    win.localStorage.setItem(FX_STORE_KEY, pref);
  } catch {
    return;
  }
}

function reducedOf(win) {
  try {
    return Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function hiddenOf(doc) {
  return Boolean(doc && (doc.hidden === true || doc.visibilityState === 'hidden'));
}

export function createLoop(win, doc = win && win.document) {
  const subs = new Set();
  let frame = 0;
  let last = 0;
  const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
  const caf = win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null;

  function tick(ts) {
    frame = 0;
    const dt = last ? Math.min(100, ts - last) : 16.7;
    last = ts;
    for (const fn of [...subs]) {
      let keep = false;
      try {
        keep = fn(ts, dt) !== false;
      } catch {
        keep = false;
      }
      if (!keep) subs.delete(fn);
    }
    schedule();
  }

  function schedule() {
    if (frame || !raf || !subs.size || hiddenOf(doc)) {
      if (!subs.size) last = 0;
      return;
    }
    frame = raf(tick);
  }

  function stop() {
    if (frame && caf) caf(frame);
    frame = 0;
    last = 0;
  }

  return {
    add(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      schedule();
      return () => {
        subs.delete(fn);
        if (!subs.size) stop();
      };
    },
    wake() {
      last = 0;
      schedule();
    },
    stop,
    clear() {
      subs.clear();
      stop();
    },
    get size() {
      return subs.size;
    },
    get running() {
      return frame !== 0;
    },
  };
}

let shared = null;
let current = 'full';

export function fxLevel() {
  return current;
}

export function sharedLoop() {
  const win = globalThis.window || globalThis;
  if (!shared) shared = createLoop(win, globalThis.document || null);
  return shared;
}

export function resetFxMode() {
  if (shared) shared.clear();
  shared = null;
  current = 'full';
}

export function countTo(el, to, { from = null, ms = COUNT_MS, format = (n) => String(Math.round(n)), loop = null } = {}) {
  if (!el) return () => {};
  const end = Number(to) || 0;
  const start = from === null || from === undefined ? null : Number(from);
  if (start === null || !Number.isFinite(start) || start === end || current === 'static') {
    el.textContent = format(end);
    return () => {};
  }
  const runner = loop || sharedLoop();
  el.textContent = format(start);
  let t0 = 0;
  const span = Math.max(1, Number(ms) || COUNT_MS);
  const off = runner.add((ts) => {
    if (!t0) t0 = ts;
    const k = Math.min(1, (ts - t0) / span);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = format(start + (end - start) * eased);
    if (k >= 1 || el.isConnected === false) {
      el.textContent = format(end);
      return false;
    }
    return true;
  });
  return () => {
    off();
    el.textContent = format(end);
  };
}

export function mountBackdrop(doc) {
  const el = doc.createElement('div');
  el.className = 'fx-backdrop';
  el.setAttribute('aria-hidden', 'true');
  for (const name of ['fx-aurora fx-aurora-1', 'fx-aurora fx-aurora-2', 'fx-aurora fx-aurora-3', 'fx-floor', 'fx-motif', 'fx-grain', 'fx-vignette']) {
    const s = doc.createElement('span');
    s.className = name;
    el.append(s);
  }
  return el;
}

export function startFxMode({ win, root = null, probe = true } = {}) {
  const doc = win && win.document ? win.document : null;
  const target = root || (doc && doc.documentElement) || null;
  const subs = new Set();
  let pref = readStore(win);
  let slow = false;
  let probing = null;
  let probeTimer = null;
  const hint = liteHint(win && win.navigator);

  function apply() {
    const next = resolveLevel({ pref, reduced: reducedOf(win), hint, slow });
    const changed = next !== current;
    current = next;
    if (target && target.dataset) target.dataset.fx = next;
    if (changed) {
      for (const fn of [...subs]) {
        try {
          fn(next);
        } catch {
          continue;
        }
      }
    }
    return next;
  }

  function onVisible() {
    const hidden = hiddenOf(doc);
    if (target && target.dataset) {
      if (hidden) target.dataset.fxPaused = 'on';
      else delete target.dataset.fxPaused;
    }
    if (hidden) {
      if (shared) shared.stop();
    } else if (shared) shared.wake();
  }

  function runProbe() {
    probeTimer = null;
    if (pref !== 'auto' || hint || current === 'static' || hiddenOf(doc)) return;
    const deltas = [];
    let prev = 0;
    probing = sharedLoop().add((ts) => {
      if (prev) deltas.push(ts - prev);
      prev = ts;
      if (deltas.length < PROBE_FRAMES) return true;
      probing = null;
      if (probeSlow(deltas)) {
        slow = true;
        apply();
      }
      return false;
    });
  }

  let mq = null;
  const onMotion = () => apply();
  try {
    mq = win && win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onMotion);
  } catch {
    mq = null;
  }
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
  apply();
  onVisible();
  if (probe && win && typeof win.setTimeout === 'function') probeTimer = win.setTimeout(runProbe, PROBE_DELAY_MS);

  return {
    get level() {
      return current;
    },
    get pref() {
      return pref;
    },
    get hint() {
      return hint;
    },
    setPref(p) {
      pref = cleanPref(p);
      writeStore(win, pref);
      return apply();
    },
    cycle() {
      return this.setPref(nextPref(pref));
    },
    button() {
      return fxButtonModel(pref, current);
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    destroy() {
      if (probeTimer !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(probeTimer);
      probeTimer = null;
      if (probing) probing();
      probing = null;
      if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMotion);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
      subs.clear();
      if (target && target.dataset) {
        delete target.dataset.fx;
        delete target.dataset.fxPaused;
      }
    },
  };
}
