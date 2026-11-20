import { sfx as defaultSfx } from '../ui/sfx.js';

export const MUSIC_GAIN = 0.6;
export const SFX_GAIN = 0.18;
export const CLICK_HZ = 1320;
export const OPEN_HZ = 18000;
export const DIP_HZ = 900;
export const DUCK = 0.708;
export const DUCK_SECS = 0.8;
export const TAP_ROOT = 57;
export const TAP_SCALE = Object.freeze([0, 3, 5, 7, 10]);

function midiHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function soundNote(state) {
  if (state === 'off') return 'Sound is off. Turn sound on to play to the music. You can still play by watching the notes.';
  if (state === 'none') return "Music can't play on this device, but you can still play by watching the notes.";
  return null;
}

function noiseSeed() {
  let a = 0x2f6b9e1d;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return ((a >>> 0) / 4294967296) * 2 - 1;
  };
}

function setAt(param, v, at) {
  if (!param) return;
  try {
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(at);
    param.setValueAtTime(v, at);
  } catch {
    param.value = v;
  }
}

export function createBeatPlayer({ sfx, win } = {}) {
  const s = sfx && typeof sfx === 'object' ? sfx : defaultSfx;
  const w = win || globalThis;
  let ctx = null;
  let master = null;
  let filter = null;
  let music = null;
  let fxBus = null;
  let noise = null;
  let voices = 0;
  let musicOn = true;
  let tapsOn = true;
  let hidden = false;
  let own = false;
  let dead = false;

  function enabled() {
    try {
      return s.enabled !== false && (typeof s.volume !== 'number' || s.volume > 0);
    } catch {
      return true;
    }
  }

  function level() {
    const v = typeof s.volume === 'number' ? s.volume : 0.5;
    return enabled() ? Math.max(0, Math.min(1, v)) : 0;
  }

  function context() {
    if (dead) return null;
    if (ctx) return ctx;
    try {
      if (typeof s.unlock === 'function') s.unlock();
    } catch {
      ctx = null;
    }
    ctx = s.context || null;
    if (!ctx) {
      const Ctor = w.AudioContext || w.webkitAudioContext || null;
      if (typeof Ctor !== 'function') return null;
      try {
        ctx = new Ctor();
        own = true;
      } catch {
        ctx = null;
      }
    }
    return ctx;
  }

  function musicLevel() {
    return musicOn && !hidden ? MUSIC_GAIN : 0;
  }

  function graph() {
    const c = context();
    if (!c) return null;
    if (master) return c;
    try {
      master = c.createGain();
      master.gain.value = level();
      master.connect(c.destination);
      if (typeof c.createBiquadFilter === 'function') {
        filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = OPEN_HZ;
        filter.connect(master);
      } else filter = master;
      music = c.createGain();
      music.gain.value = musicLevel();
      music.connect(filter);
      fxBus = c.createGain();
      fxBus.gain.value = SFX_GAIN;
      fxBus.connect(filter);
    } catch {
      master = null;
      return null;
    }
    return c;
  }

  function status() {
    if (!enabled()) return 'off';
    const c = context();
    if (!c) return 'none';
    if (c.state === 'suspended') return 'blocked';
    return 'ok';
  }

  function ensure() {
    if (!enabled()) return 'off';
    const c = graph();
    if (!c) return 'none';
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') {
        const p = c.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {
      return 'blocked';
    }
    return status();
  }

  function now() {
    return ctx ? Number(ctx.currentTime) || 0 : 0;
  }

  function outLat() {
    if (!ctx) return 0;
    const v = Number(ctx.outputLatency) || Number(ctx.baseLatency) || 0;
    return v > 0 && v < 0.5 ? v : 0;
  }

  function noiseBuf(c) {
    if (noise) return noise;
    if (typeof c.createBuffer !== 'function' || typeof c.createBufferSource !== 'function') return null;
    try {
      const rate = c.sampleRate || 44100;
      const buf = c.createBuffer(1, Math.floor(rate * 0.5), rate);
      const data = buf.getChannelData(0);
      const r = noiseSeed();
      for (let i = 0; i < data.length; i += 1) data[i] = r();
      noise = buf;
    } catch {
      noise = null;
    }
    return noise;
  }

  function env(g, at, peak, attack, dur) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  }

  function osc(c, out, { type, hz, to = null, at, dur, peak, attack = 0.005 }) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur * 0.6);
    env(g, at, peak, attack, dur);
    o.connect(g);
    g.connect(out);
    o.start(at);
    o.stop(at + dur + 0.03);
    voices += 1;
  }

  function hiss(c, out, { at, dur, peak, type, hz }) {
    const buf = noiseBuf(c);
    if (!buf || typeof c.createBiquadFilter !== 'function') return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(hz, at);
    const g = c.createGain();
    env(g, at, peak, 0.002, dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(at);
    src.stop(at + dur + 0.03);
    voices += 1;
  }

  function setMix({ music: m, taps } = {}) {
    if (typeof m === 'boolean') musicOn = m;
    if (typeof taps === 'boolean') tapsOn = taps;
    if (music && ctx) setAt(music.gain, musicLevel(), now());
  }

  function mute(on) {
    hidden = Boolean(on);
    if (music && ctx) setAt(music.gain, musicLevel(), now());
  }

  function fx() {
    if (!enabled() || !tapsOn) return null;
    const c = graph();
    if (!c || c.state === 'suspended' || !fxBus) return null;
    return c;
  }

  function hit(laneIdx, kind) {
    const c = fx();
    if (!c) return false;
    try {
      const at = now();
      const m = TAP_ROOT + 24 + TAP_SCALE[Math.max(0, laneIdx) % TAP_SCALE.length] + (kind === 'p' ? 12 : 0);
      hiss(c, fxBus, { at, dur: 0.03, peak: 0.5, type: 'bandpass', hz: 3200 });
      osc(c, fxBus, { type: 'triangle', hz: midiHz(m), at, dur: 0.07, peak: 0.55, attack: 0.002 });
      if (kind === 'p') osc(c, fxBus, { type: 'sine', hz: midiHz(m) * 3, at, dur: 0.12, peak: 0.08, attack: 0.002 });
      return true;
    } catch {
      return false;
    }
  }

  function stray() {
    const c = fx();
    if (!c) return false;
    try {
      hiss(c, fxBus, { at: now(), dur: 0.02, peak: 0.18, type: 'highpass', hz: 2400 });
      return true;
    } catch {
      return false;
    }
  }

  function miss() {
    const c = fx();
    if (!c) return false;
    try {
      const at = now();
      osc(c, fxBus, { type: 'sine', hz: 110, at, dur: 0.06, peak: 0.55, attack: 0.002 });
      if (filter && filter !== master && filter.frequency) {
        const f = filter.frequency;
        setAt(f, OPEN_HZ, at);
        f.exponentialRampToValueAtTime(DIP_HZ, at + 0.05);
        f.exponentialRampToValueAtTime(OPEN_HZ, at + 0.2);
      }
      return true;
    } catch {
      return false;
    }
  }

  function tierUp() {
    const c = fx();
    if (!c) return false;
    try {
      const at = now();
      [TAP_ROOT + 24, TAP_ROOT + 27, TAP_ROOT + 31].forEach((m, i) => osc(c, fxBus, { type: 'triangle', hz: midiHz(m), at: at + i * 0.07, dur: 0.16, peak: 0.4, attack: 0.004 }));
      return true;
    } catch {
      return false;
    }
  }

  function swell() {
    const c = fx();
    if (!c) return false;
    try {
      const at = now();
      for (const m of [0, 4, 7, 12]) osc(c, fxBus, { type: 'triangle', hz: midiHz(TAP_ROOT + 24 + m), at, dur: 1.4, peak: 0.22, attack: 0.25 });
      return true;
    } catch {
      return false;
    }
  }

  function duck(secs = DUCK_SECS) {
    if (!music || !ctx) return false;
    try {
      const at = now();
      setAt(music.gain, musicLevel() * DUCK, at);
      music.gain.linearRampToValueAtTime(musicLevel(), at + secs);
      return true;
    } catch {
      return false;
    }
  }

  function click(delaySec, accent = false) {
    if (!enabled()) return false;
    const c = graph();
    if (!c || !filter) return false;
    try {
      osc(c, filter, { type: 'sine', hz: accent ? CLICK_HZ * 1.5 : CLICK_HZ, at: now() + Math.max(0, delaySec), dur: 0.08, peak: 0.12, attack: 0.002 });
      return true;
    } catch {
      return false;
    }
  }

  function bus() {
    if (!enabled()) return null;
    const c = graph();
    return c && music ? music : null;
  }

  const off = typeof s.on === 'function'
    ? s.on('change', () => {
        if (master && ctx) setAt(master.gain, level(), now());
      })
    : null;

  return {
    setMix,
    mute,
    ensure,
    outLat,
    now,
    hit,
    stray,
    miss,
    tierUp,
    swell,
    duck,
    click,
    status,
    context,
    bus,
    get voices() {
      return voices;
    },
    get sfx() {
      return s;
    },
    get mix() {
      return { music: musicOn, taps: tapsOn };
    },
    destroy() {
      dead = true;
      if (typeof off === 'function') off();
      for (const n of [music, fxBus, filter, master]) {
        try {
          if (n) n.disconnect();
        } catch {
          continue;
        }
      }
      music = null;
      fxBus = null;
      filter = null;
      master = null;
      noise = null;
      if (own && ctx && typeof ctx.close === 'function') {
        try {
          const p = ctx.close();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          own = false;
        }
      }
      ctx = null;
    },
  };
}
