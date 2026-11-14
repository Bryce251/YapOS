export const SOUND_KEY = 'yapos.party.sound';
export const RATE_MS = 40;
export const BURST_MS = 250;
export const BURST_MAX = 10;
export const DEFAULT_VOLUME = 0.5;

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;
const SPARKLE = [1567.98, 1760, 2093, 2349.32, 2637.02];

function hostWin() {
  if (typeof window !== 'undefined' && window) return window;
  return globalThis;
}

function clamp01(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export const SOUNDS = {
  tap(v) {
    v.tone({ type: 'sine', freq: 620, to: 420, dur: 0.07, gain: 0.22, attack: 0.003 });
    v.noise({ dur: 0.02, gain: 0.05, filter: 'highpass', freq: 3200 });
  },
  pop(v) {
    v.tone({ type: 'sine', freq: 980, to: 260, dur: 0.13, gain: 0.3, attack: 0.002 });
  },
  whoosh(v) {
    v.noise({ dur: 0.42, gain: 0.26, filter: 'bandpass', freq: 320, to: 2600, q: 1.2, attack: 0.12 });
  },
  toggle(v) {
    v.tone({ type: 'triangle', freq: 660, dur: 0.06, gain: 0.18 });
    v.tone({ type: 'triangle', freq: 990, dur: 0.07, gain: 0.16, at: 0.05 });
  },
  join(v) {
    v.tone({ type: 'sine', freq: C5, dur: 0.16, gain: 0.2 });
    v.tone({ type: 'sine', freq: E5, dur: 0.16, gain: 0.2, at: 0.07 });
    v.tone({ type: 'sine', freq: G5, dur: 0.26, gain: 0.2, at: 0.14 });
  },
  leave(v) {
    v.tone({ type: 'triangle', freq: G5, dur: 0.16, gain: 0.16 });
    v.tone({ type: 'triangle', freq: C5, dur: 0.28, gain: 0.16, at: 0.1 });
  },
  start(v) {
    v.tone({ type: 'sine', freq: 300, to: 900, dur: 0.3, gain: 0.14, attack: 0.08 });
    v.tone({ type: 'triangle', freq: C5, dur: 0.5, gain: 0.14, at: 0.26 });
    v.tone({ type: 'triangle', freq: E5, dur: 0.5, gain: 0.12, at: 0.26 });
    v.tone({ type: 'triangle', freq: G5, dur: 0.6, gain: 0.12, at: 0.26 });
    v.tone({ type: 'sine', freq: C6, dur: 0.6, gain: 0.1, at: 0.32 });
  },
  tick(v) {
    v.tone({ type: 'sine', freq: 1180, dur: 0.05, gain: 0.18, attack: 0.002 });
  },
  tickLast(v) {
    v.tone({ type: 'sine', freq: 1560, dur: 0.07, gain: 0.22, attack: 0.002 });
    v.tone({ type: 'sine', freq: 3120, dur: 0.04, gain: 0.05, attack: 0.002 });
  },
  turn(v) {
    v.tone({ type: 'sine', freq: G5, dur: 0.16, gain: 0.2 });
    v.tone({ type: 'sine', freq: C6, dur: 0.32, gain: 0.2, at: 0.1 });
    v.tone({ type: 'sine', freq: 2 * C6, dur: 0.22, gain: 0.04, at: 0.1 });
  },
  correct(v) {
    v.tone({ type: 'triangle', freq: C6, dur: 0.14, gain: 0.16 });
    v.tone({ type: 'triangle', freq: E6, dur: 0.14, gain: 0.16, at: 0.06 });
    v.tone({ type: 'triangle', freq: G6, dur: 0.3, gain: 0.16, at: 0.12 });
  },
  wrong(v) {
    v.tone({ type: 'sine', freq: 330, to: 300, dur: 0.16, gain: 0.2 });
    v.tone({ type: 'sine', freq: 262, to: 240, dur: 0.26, gain: 0.2, at: 0.12 });
  },
  coin(v) {
    v.tone({ type: 'square', freq: 987.77, dur: 0.08, gain: 0.07, attack: 0.002 });
    v.tone({ type: 'square', freq: E6, dur: 0.26, gain: 0.07, at: 0.07, attack: 0.002 });
  },
  win(v) {
    const run = [C5, E5, G5, C6];
    run.forEach((f, i) => v.tone({ type: 'triangle', freq: f, dur: 0.16, gain: 0.15, at: i * 0.11 }));
    for (const f of [C5, E5, G5, C6]) v.tone({ type: 'triangle', freq: f, dur: 1.25, gain: 0.08, at: 0.5, attack: 0.02 });
    v.tone({ type: 'sine', freq: 2 * C6, dur: 0.9, gain: 0.03, at: 0.5 });
    SPARKLE.forEach((f, i) => v.tone({ type: 'sine', freq: f, dur: 0.16, gain: 0.04, at: 0.55 + i * 0.07 }));
  },
  lose(v) {
    [392, 349.23, 311.13, 261.63].forEach((f, i) => v.tone({ type: 'triangle', freq: f, dur: i === 3 ? 0.45 : 0.22, gain: 0.14, at: i * 0.15 }));
  },
  reveal(v) {
    v.noise({ dur: 0.36, gain: 0.08, filter: 'bandpass', freq: 600, to: 3000, q: 0.9, attack: 0.25 });
    v.tone({ type: 'sine', freq: 360, to: 880, dur: 0.32, gain: 0.1, attack: 0.2 });
    v.tone({ type: 'sine', freq: C6, dur: 0.6, gain: 0.16, at: 0.3 });
    v.tone({ type: 'sine', freq: G6, dur: 0.5, gain: 0.06, at: 0.3 });
  },
  send(v) {
    v.tone({ type: 'sine', freq: 440, to: 920, dur: 0.11, gain: 0.18, attack: 0.004 });
  },
  error(v) {
    v.tone({ type: 'triangle', freq: 233, dur: 0.11, gain: 0.17 });
    v.tone({ type: 'triangle', freq: 196, dur: 0.18, gain: 0.17, at: 0.1 });
  },
  fx(v) {
    for (let i = 0; i < 5; i += 1) v.tone({ type: 'sine', freq: SPARKLE[Math.floor(v.random() * SPARKLE.length)], dur: 0.18, gain: 0.06, at: i * 0.06 + v.random() * 0.02 });
  },
  type(v) {
    v.noise({ dur: 0.018, gain: 0.04, filter: 'highpass', freq: 2600 });
  },
};

export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

export function createSfx({ AudioContext: Injected = null, storage = undefined, now = null, random = Math.random } = {}) {
  const listeners = new Set();
  const lastAt = new Map();
  let recent = [];
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let broken = false;
  let enabled = null;
  let volume = DEFAULT_VOLUME;

  function store() {
    if (storage !== undefined) return storage;
    try {
      return typeof window !== 'undefined' && window ? window.localStorage || null : null;
    } catch {
      return null;
    }
  }

  function readEnabled() {
    try {
      const s = store();
      const v = s ? s.getItem(SOUND_KEY) : null;
      return v !== 'off';
    } catch {
      return true;
    }
  }

  function writeEnabled() {
    try {
      const s = store();
      if (s) s.setItem(SOUND_KEY, enabled ? 'on' : 'off');
    } catch {
      return false;
    }
    return true;
  }

  function clock() {
    if (typeof now === 'function') return now();
    try {
      const p = hostWin().performance;
      if (p && typeof p.now === 'function') return p.now();
    } catch {
      return Date.now();
    }
    return Date.now();
  }

  function ctorOf() {
    if (Injected) return Injected;
    try {
      const w = hostWin();
      return w.AudioContext || w.webkitAudioContext || null;
    } catch {
      return null;
    }
  }

  function isOn() {
    if (enabled === null) enabled = readEnabled();
    return enabled;
  }

  function level() {
    return isOn() ? volume : 0;
  }

  function ensure() {
    if (ctx) return ctx;
    if (broken) return null;
    const Ctor = ctorOf();
    if (typeof Ctor !== 'function') return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = level();
      let out = ctx.destination;
      if (typeof ctx.createDynamicsCompressor === 'function') {
        const comp = ctx.createDynamicsCompressor();
        comp.connect(out);
        out = comp;
      }
      master.connect(out);
      return ctx;
    } catch {
      broken = true;
      ctx = null;
      master = null;
      return null;
    }
  }

  function applyLevel() {
    if (!ctx || !master) return;
    try {
      const t = ctx.currentTime || 0;
      if (typeof master.gain.cancelScheduledValues === 'function') master.gain.cancelScheduledValues(t);
      if (typeof master.gain.setTargetAtTime === 'function') master.gain.setTargetAtTime(level(), t, 0.015);
      else master.gain.value = level();
    } catch {
      master.gain.value = level();
    }
  }

  function emit() {
    const state = { enabled: isOn(), volume };
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch {
        continue;
      }
    }
  }

  function activation() {
    try {
      const nav = hostWin().navigator;
      const ua = nav && nav.userActivation;
      return ua && typeof ua === 'object' ? ua : null;
    } catch {
      return null;
    }
  }

  function mayStart() {
    if (ctx) return true;
    const ua = activation();
    return !ua || Boolean(ua.hasBeenActive);
  }

  function asleep() {
    if (!ctx || ctx.state !== 'suspended') return false;
    const ua = activation();
    return Boolean(ua && !ua.isActive);
  }

  function resume() {
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      return;
    }
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    const rate = ctx.sampleRate || 44100;
    const buf = ctx.createBuffer(1, Math.floor(rate * 0.5), rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  function envelope(g, t, peak, attack, dur) {
    const p = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(p, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function voice(bus, t0, shift) {
    return {
      random,
      tone({ type = 'sine', freq, to = null, dur = 0.1, gain = 0.2, attack = 0.005, at = 0 }) {
        const t = t0 + at;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq * shift, t);
        if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to * shift), t + dur);
        envelope(g, t, gain, Math.min(attack, dur / 2), dur);
        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(t + dur + 0.03);
      },
      noise({ dur = 0.1, gain = 0.1, filter = 'bandpass', freq = 1000, to = null, q = 1, attack = 0.004, at = 0 }) {
        const t = t0 + at;
        const src = ctx.createBufferSource();
        src.buffer = noise();
        const f = ctx.createBiquadFilter();
        f.type = filter;
        f.Q.value = q;
        f.frequency.setValueAtTime(freq * shift, t);
        if (to) f.frequency.exponentialRampToValueAtTime(to * shift, t + dur);
        const g = ctx.createGain();
        envelope(g, t, gain, Math.min(attack, dur / 2), dur);
        src.connect(f);
        f.connect(g);
        g.connect(bus);
        src.start(t);
        src.stop(t + dur + 0.03);
      },
    };
  }

  function play(name, opts = {}) {
    try {
      if (!isOn() || volume <= 0) return false;
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SOUNDS, name)) return false;
      const o = opts && typeof opts === 'object' ? opts : {};
      const t = clock();
      const prev = lastAt.get(name);
      if (prev !== undefined && t - prev < RATE_MS && t >= prev) return false;
      recent = recent.filter((x) => t - x < BURST_MS && t >= x);
      if (recent.length >= BURST_MAX) return false;
      if (!mayStart() || !ensure()) return false;
      resume();
      if (asleep()) return false;
      lastAt.set(name, t);
      recent.push(t);
      const mult = clamp01(o.volume, 1);
      if (mult <= 0) return false;
      const bus = ctx.createGain();
      bus.gain.value = mult;
      bus.connect(master);
      const semis = Number(o.pitch) || 0;
      const delay = Math.max(0, Number(o.at) || 0) / 1000;
      SOUNDS[name](voice(bus, (ctx.currentTime || 0) + 0.005 + delay, 2 ** (Math.max(-24, Math.min(24, semis)) / 12)));
      return true;
    } catch {
      return false;
    }
  }

  function setEnabled(on) {
    const next = Boolean(on);
    const changed = next !== isOn();
    enabled = next;
    writeEnabled();
    applyLevel();
    if (changed) emit();
    return enabled;
  }

  function setVolume(v) {
    const next = clamp01(v, volume);
    const changed = next !== volume;
    volume = next;
    applyLevel();
    if (changed) emit();
    return volume;
  }

  function on(type, fn) {
    if (type !== 'change' || typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function unlock() {
    try {
      if (!isOn()) return false;
      if (!ensure()) return false;
      resume();
      return true;
    } catch {
      return false;
    }
  }

  return {
    play,
    setEnabled,
    setVolume,
    on,
    unlock,
    get enabled() {
      return isOn();
    },
    get volume() {
      return volume;
    },
    get context() {
      return ctx;
    },
  };
}

export const sfx = createSfx();
export default sfx;
