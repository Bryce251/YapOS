import { stepAt, STEPS, styleById, STYLES } from '../games/beatchart.js';
import { sfx as defaultSfx } from '../ui/sfx.js';

export const MUSIC_GAIN = 0.5;
export const LOOKAHEAD = 0.35;
export const PUMP_MS = 90;
export const CLICK_HZ = 1320;

export function midiHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function soundNote(state) {
  if (state === 'off') return 'Sound is off. Turn sound on to play to the music. You can still play by watching the notes.';
  if (state === 'none') return "Music can't play on this device, but you can still play by watching the notes.";
  if (state === 'blocked') return 'Tap anywhere to start the music.';
  return null;
}

function later(w, fn, ms) {
  const set = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : globalThis.setTimeout;
  return set(fn, ms);
}

function cancel(w, id) {
  const clear = typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : globalThis.clearTimeout;
  clear(id);
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

export function createBeatPlayer({ sfx, win } = {}) {
  const s = sfx && typeof sfx === 'object' ? sfx : defaultSfx;
  const w = win || globalThis;
  let ctx = null;
  let bus = null;
  let noise = null;
  let pump = null;
  let song = null;
  let zero = 0;
  let k = 0;
  let voices = 0;

  function enabled() {
    try {
      return s.enabled !== false && (typeof s.volume !== 'number' || s.volume > 0);
    } catch {
      return true;
    }
  }

  function level() {
    const v = typeof s.volume === 'number' ? s.volume : 0.5;
    return enabled() ? Math.max(0, Math.min(1, v)) * MUSIC_GAIN : 0;
  }

  function context() {
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
      } catch {
        ctx = null;
      }
    }
    return ctx;
  }

  function status() {
    if (!enabled()) return 'off';
    const c = context();
    if (!c) return 'none';
    if (c.state === 'suspended') return 'blocked';
    return 'ok';
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

  function osc(c, out, { type, hz, to = null, at, dur, peak, attack = 0.005, cut = null }) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur * 0.6);
    env(g, at, peak, attack, dur);
    let tail = g;
    if (cut && typeof c.createBiquadFilter === 'function') {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cut, at);
      g.connect(f);
      tail = f;
    }
    o.connect(g);
    tail.connect(out);
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

  function voice(c, ev, at) {
    const st = styleById(song.style) || STYLES[0];
    const stepLen = song.step;
    if (ev.kick) osc(c, bus, { type: 'sine', hz: 150, to: 44, at, dur: 0.28, peak: 0.95, attack: 0.002 });
    if (ev.snare) {
      const soft = ev.roll ? 0.5 : 1;
      hiss(c, bus, { at, dur: ev.roll ? 0.08 : 0.16, peak: 0.42 * soft, type: 'bandpass', hz: 1900 });
      osc(c, bus, { type: 'triangle', hz: 210, to: 160, at, dur: 0.1, peak: 0.3 * soft });
    }
    if (ev.hat) hiss(c, bus, { at, dur: 0.045, peak: 0.16, type: 'highpass', hz: 7200 });
    if (ev.crash) hiss(c, bus, { at, dur: 1.1, peak: 0.16, type: 'highpass', hz: 4800 });
    if (ev.bass !== null) osc(c, bus, { type: st.wave, hz: midiHz(ev.bass), at, dur: Math.max(0.12, stepLen * 1.8), peak: 0.36, attack: 0.006, cut: st.cut });
    if (ev.chord) {
      const long = ev.sec === 'outro' ? 2.2 : (ev.sec === 'drop' ? 0.5 : 1) * song.bar * 0.95;
      for (const m of ev.chord) osc(c, bus, { type: 'triangle', hz: midiHz(m), at, dur: long, peak: ev.sec === 'drop' ? 0.1 : 0.075, attack: 0.04 });
    }
    if (ev.arp !== null) osc(c, bus, { type: 'square', hz: midiHz(ev.arp), at, dur: stepLen * 1.6, peak: 0.05, attack: 0.004, cut: 2600 });
  }

  function stopPump() {
    if (pump !== null) cancel(w, pump);
    pump = null;
  }

  function stop() {
    stopPump();
    if (bus) {
      try {
        bus.disconnect();
      } catch {
        bus = null;
      }
    }
    bus = null;
    song = null;
  }

  function tick() {
    pump = null;
    if (!song || !bus || !ctx) return;
    const total = song.bars * STEPS;
    const horizon = (ctx.currentTime || 0) + LOOKAHEAD;
    try {
      while (k < total) {
        const ev = stepAt(song, k);
        const at = zero + ev.t;
        if (at > horizon) break;
        if (at >= (ctx.currentTime || 0) - 0.02) voice(ctx, ev, Math.max(at, ctx.currentTime || 0));
        k += 1;
      }
    } catch {
      stop();
      return;
    }
    if (k < total) pump = later(w, tick, PUMP_MS);
  }

  function start(next, songStartMs, nowMs) {
    stop();
    if (!next || !enabled()) return false;
    const c = context();
    if (!c) return false;
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') {
        const p = c.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      song = next;
      bus = c.createGain();
      bus.gain.value = level();
      bus.connect(c.destination);
      zero = (c.currentTime || 0) + (songStartMs - nowMs) / 1000;
      const into = Math.max(0, (nowMs - songStartMs) / 1000);
      k = Math.max(0, Math.floor(into / song.step));
      tick();
      return true;
    } catch {
      stop();
      return false;
    }
  }

  function click(delaySec, accent = false) {
    if (!enabled()) return false;
    const c = context();
    if (!c) return false;
    try {
      const out = c.createGain();
      out.gain.value = level();
      out.connect(c.destination);
      osc(c, out, { type: 'sine', hz: accent ? CLICK_HZ * 1.5 : CLICK_HZ, at: (c.currentTime || 0) + Math.max(0, delaySec), dur: 0.08, peak: 0.6, attack: 0.002 });
      return true;
    } catch {
      return false;
    }
  }

  const off = typeof s.on === 'function'
    ? s.on('change', () => {
        if (!enabled()) stop();
        else if (bus && ctx) {
          try {
            bus.gain.setTargetAtTime(level(), ctx.currentTime || 0, 0.02);
          } catch {
            bus.gain.value = level();
          }
        }
      })
    : null;

  return {
    start,
    stop,
    click,
    status,
    get playing() {
      return Boolean(song && bus);
    },
    get voices() {
      return voices;
    },
    get sfx() {
      return s;
    },
    destroy() {
      stop();
      if (typeof off === 'function') off();
    },
  };
}
