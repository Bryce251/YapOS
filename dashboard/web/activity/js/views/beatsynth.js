import { sfx as defaultSfx } from '../ui/sfx.js';

export const MUSIC_GAIN = 0.6;
export const CLICK_HZ = 1320;
export const OPEN_HZ = 18000;
export const DUCK = 0.708;
export const DUCK_SECS = 0.8;

export function soundNote(state) {
  if (state === 'off') return 'Sound is off. Turn sound on to play to the music. You can still play by watching the notes.';
  if (state === 'none') return "Music can't play on this device, but you can still play by watching the notes.";
  return null;
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
  let voices = 0;
  let musicOn = true;
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

  function setMix({ music: m } = {}) {
    if (typeof m === 'boolean') musicOn = m;
    if (music && ctx) setAt(music.gain, musicLevel(), now());
  }

  function mute(on) {
    hidden = Boolean(on);
    if (music && ctx) setAt(music.gain, musicLevel(), now());
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
      return { music: musicOn };
    },
    destroy() {
      dead = true;
      if (typeof off === 'function') off();
      for (const n of [music, filter, master]) {
        try {
          if (n) n.disconnect();
        } catch {
          continue;
        }
      }
      music = null;
      filter = null;
      master = null;
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
