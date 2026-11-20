import { songFetch } from '../games/beatsongs.js';

export const DECODE_RATE = 32000;
export const SLICE_PAD_S = 2;
export const FADE_S = 1.5;
export const RESYNC_S = 0.15;
export const AUDIO_MAX_BYTES = 8388608;
export const CACHE_MAX = 2;

function setAt(param, v, at) {
  if (!param) return;
  try {
    param.setValueAtTime(v, at);
  } catch {
    param.value = v;
  }
}

export function songSpan(song) {
  const meta = song && song.meta ? song.meta : null;
  if (!meta) return null;
  return { url: meta.url, from: ((Number(meta.start) || 0) + (Number(meta.off) || 0)) / 1000, len: (Number(song.cut) || 0) / 1000 };
}

export function createSongAudio({ win, get = songFetch } = {}) {
  const w = win || globalThis;
  const cache = new Map();
  const busy = new Map();
  let src = null;
  let gain = null;
  let cur = null;
  let dead = false;

  function keyOf(url, from, len) {
    return `${url}|${from.toFixed(3)}|${len.toFixed(3)}`;
  }

  async function readAll(res, onProgress) {
    const head = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Content-Length')) : 0;
    const total = Number.isFinite(head) && head > 0 ? head : 0;
    if (total > AUDIO_MAX_BYTES) throw new Error('The song is too big.');
    if (!res.body || typeof res.body.getReader !== 'function') {
      const whole = await res.arrayBuffer();
      if (whole.byteLength > AUDIO_MAX_BYTES) throw new Error('The song is too big.');
      onProgress(1);
      return whole;
    }
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      parts.push(value);
      got += value.byteLength;
      if (got > AUDIO_MAX_BYTES) {
        try {
          reader.cancel();
        } catch {
          parts.length = 0;
        }
        throw new Error('The song is too big.');
      }
      if (total) onProgress(Math.min(0.99, got / total));
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    onProgress(1);
    return out.buffer;
  }

  function decoder() {
    const C = w.OfflineAudioContext || w.webkitOfflineAudioContext || null;
    if (typeof C !== 'function') return null;
    try {
      return new C(2, 1, DECODE_RATE);
    } catch {
      return null;
    }
  }

  function decode(ctx, data) {
    return new Promise((resolve, reject) => {
      try {
        const p = ctx.decodeAudioData(data, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  function slice(ctx, full, from, len) {
    const rate = full.sampleRate;
    const a = Math.max(0, Math.min(full.length - 1, Math.floor(Math.max(0, from) * rate)));
    const b = Math.min(full.length, Math.ceil((from + len + SLICE_PAD_S) * rate));
    const n = Math.max(1, b - a);
    const ch = Math.max(1, Math.min(2, full.numberOfChannels || 1));
    const out = ctx.createBuffer(ch, n, rate);
    for (let c = 0; c < ch; c += 1) {
      const part = full.getChannelData(c).subarray(a, a + n);
      if (typeof out.copyToChannel === 'function') out.copyToChannel(part, c);
      else out.getChannelData(c).set(part);
    }
    return { buf: out, base: from - a / rate };
  }

  function ready(url, from, len) {
    return cache.get(keyOf(url, from, len)) || null;
  }

  function load(url, { from = 0, len = 60, onProgress = () => {} } = {}) {
    if (dead) return Promise.reject(new Error('The player is closed.'));
    const k = keyOf(url, from, len);
    if (cache.has(k)) {
      onProgress(1);
      return Promise.resolve(cache.get(k));
    }
    if (busy.has(k)) return busy.get(k);
    const p = Promise.resolve()
      .then(() => get(url, { credentials: 'same-origin' }))
      .then((res) => {
        if (!res || !res.ok) throw new Error('The song did not load.');
        return readAll(res, onProgress);
      })
      .then((data) => {
        const ctx = decoder();
        if (!ctx) throw new Error('This device can not play songs.');
        return decode(ctx, data).then((full) => slice(ctx, full, from, len));
      })
      .then(
        (entry) => {
          busy.delete(k);
          if (dead) throw new Error('The player is closed.');
          cache.set(k, entry);
          while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
          return entry;
        },
        (err) => {
          busy.delete(k);
          throw err;
        },
      );
    busy.set(k, p);
    return p;
  }

  function stop() {
    const s = src;
    const g = gain;
    src = null;
    gain = null;
    cur = null;
    try {
      if (s) s.stop();
    } catch {
      src = null;
    }
    for (const node of [s, g]) {
      try {
        if (node) node.disconnect();
      } catch {
        continue;
      }
    }
  }

  function play({ ctx, out, entry, zero, len }) {
    stop();
    if (dead || !ctx || !entry || !entry.buf || typeof ctx.createBufferSource !== 'function') return false;
    const now = Number(ctx.currentTime) || 0;
    const z = Number(zero) || 0;
    let when = z;
    let offset = entry.base;
    if (now > when) {
      offset += now - when;
      when = now;
    }
    if (offset < 0) {
      when -= offset;
      offset = 0;
    }
    const endAt = z + Math.max(0, Number(len) || 0);
    const dur = endAt - when;
    if (dur <= 0.05) return false;
    try {
      src = ctx.createBufferSource();
      src.buffer = entry.buf;
      gain = ctx.createGain();
      setAt(gain.gain, 1, when);
      const fadeAt = Math.max(when, endAt - FADE_S);
      setAt(gain.gain, 1, fadeAt);
      if (typeof gain.gain.linearRampToValueAtTime === 'function') gain.gain.linearRampToValueAtTime(0.0001, endAt);
      src.connect(gain);
      gain.connect(out || ctx.destination);
      src.start(when, offset, dur);
      cur = { ctx, out, entry, zero: z, len };
      return true;
    } catch {
      stop();
      return false;
    }
  }

  function resync(zero) {
    if (!cur) return false;
    if (Math.abs((Number(zero) || 0) - cur.zero) <= RESYNC_S) return false;
    return play({ ...cur, zero });
  }

  return {
    load,
    ready,
    play,
    resync,
    stop,
    get playing() {
      return Boolean(cur);
    },
    get zero() {
      return cur ? cur.zero : null;
    },
    get cached() {
      return cache.size;
    },
    destroy() {
      dead = true;
      stop();
      cache.clear();
      busy.clear();
    },
  };
}
