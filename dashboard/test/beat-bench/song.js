import { RATE, rng, gauss, reverb, vinyl, crowd, svf } from './synth.js';

export class Song {
  constructor({ id, genre, secs, seed, jitter = 8, meter = 4, start = 0.5, bpm, tempo = null, notes = '' }) {
    this.id = id;
    this.genre = genre;
    this.secs = secs;
    this.meter = meter;
    this.notes = notes;
    this.nominal = bpm;
    this.r = rng(seed);
    this.jit = jitter / 1000;
    this.n = Math.ceil(secs * RATE);
    this.dry = new Float32Array(this.n);
    this.pad = new Float32Array(this.n);
    this.send = new Float32Array(this.n);
    this.kicks = [];
    this.onsets = [];
    this.layers = [];
    this.start = start;
    const tf = tempo || (() => bpm);
    const beats = [start];
    for (let i = 0; beats[beats.length - 1] < secs + 4; i++) beats.push(beats[i] + 60 / tf(i, beats[i]));
    this.beats = beats;
    this.fx = { wet: 0, size: 1, sidechain: 0, lp: 0, noise: [] };
  }

  bars() {
    let b = 0;
    while (this.at(b * this.meter) < this.secs) b += 1;
    return b;
  }

  at(pos) {
    const B = this.beats;
    const i = Math.max(0, Math.min(B.length - 2, Math.floor(pos)));
    return B[i] + (pos - i) * (B[i + 1] - B[i]);
  }

  human() {
    if (!this.jit) return 0;
    const j = gauss(this.r) * this.jit * 0.5;
    return Math.max(-this.jit, Math.min(this.jit, j));
  }

  place(arr, t, gain, bus, send) {
    const s0 = Math.round(t * RATE);
    const dst = bus === 'pad' ? this.pad : this.dry;
    const end = Math.min(this.n, s0 + arr.length);
    for (let i = Math.max(0, s0); i < end; i++) {
      const v = arr[i - s0] * gain;
      dst[i] += v;
      if (send) this.send[i] += v * send;
    }
  }

  play(pos, arr, { gain = 1, vel = 1, bus = 'dry', send = 0, band = 'M', soft = false, inst = '', exact = false, onset = true, kick = false, shift = 0 } = {}) {
    const t = this.at(pos) + shift + (exact ? 0 : this.human());
    if (t < 0 || t >= this.secs - 0.05) return null;
    const v = vel * Math.max(0.6, Math.min(1.4, 1 + 0.07 * gauss(this.r)));
    this.place(arr, t, gain * v, bus, send);
    if (onset) this.onsets.push({ t, band, soft: !!soft, inst });
    if (kick) this.kicks.push(t);
    return t;
  }

  playAt(t, arr, opts = {}) {
    if (t < 0 || t >= this.secs) return;
    this.place(arr, t, opts.gain ?? 1, opts.bus ?? 'dry', opts.send ?? 0);
    if (opts.onset) this.onsets.push({ t, band: opts.band ?? 'M', soft: !!opts.soft, inst: opts.inst ?? '' });
  }

  render() {
    const out = new Float32Array(this.n);
    if (this.fx.sidechain && this.kicks.length) {
      const ks = [...this.kicks].sort((a, b) => a - b);
      let k = -1;
      for (let i = 0; i < this.n; i++) {
        const t = i / RATE;
        while (k + 1 < ks.length && ks[k + 1] <= t + 0.004) k += 1;
        const g = k >= 0 ? 1 - this.fx.sidechain * Math.exp(-Math.max(0, t - ks[k]) / 0.14) : 1;
        out[i] += this.pad[i] * g;
      }
    } else for (let i = 0; i < this.n; i++) out[i] += this.pad[i];
    for (let i = 0; i < this.n; i++) out[i] += this.dry[i];
    if (this.fx.wet) {
      const wet = reverb(this.send, this.fx.wet, this.fx.size);
      for (let i = 0; i < this.n; i++) out[i] += wet[i];
    }
    if (this.fx.lp) svf(out, this.fx.lp, 0.6, 'lp');
    let peak = 1e-9;
    for (let i = 0; i < this.n; i++) peak = Math.max(peak, Math.abs(out[i]));
    const g = 0.95 / peak;
    for (let i = 0; i < this.n; i++) out[i] = Math.tanh(1.3 * out[i] * g) / Math.tanh(1.3);
    for (const [kind, level, rate] of this.fx.noise) {
      const layer = kind === 'vinyl' ? vinyl(this.r, this.n, level, rate) : crowd(this.r, this.n, level);
      const from = Math.round((this.fx.noiseFrom || 0) * RATE);
      for (let i = from; i < this.n; i++) out[i] += layer[i];
    }
    if (this.silentUntil) for (let i = 0; i < Math.round(this.silentUntil * RATE); i++) out[i] = 0;
    return out;
  }

  truth() {
    const last = this.secs - 0.1;
    const first = this.firstBeat ?? 0;
    const beats = [];
    const downbeats = [];
    for (let i = first; i < this.beats.length && this.beats[i] <= last; i++) {
      beats.push(round(this.beats[i]));
      if (i % this.meter === 0) downbeats.push(round(this.beats[i]));
    }
    const segs = [];
    for (let i = 1; i < beats.length; i++) {
      const bpm = Math.round((600 / (beats[i] - beats[i - 1]))) / 10;
      segs.push({ bpm, d: beats[i] - beats[i - 1] });
    }
    const groups = [];
    for (const s of segs) {
      const g = groups.find((x) => Math.abs(x.bpm - s.bpm) / x.bpm < 0.04);
      if (g) {
        g.d += s.d;
        g.sum += s.bpm * s.d;
      } else groups.push({ bpm: s.bpm, d: s.d, sum: s.bpm * s.d });
    }
    groups.sort((a, b) => b.d - a.d);
    const tempos = groups.filter((g) => g.d >= 8).map((g) => Math.round((g.sum / g.d) * 100) / 100);
    const onsets = this.onsets
      .filter((o) => o.t < this.secs - 0.05)
      .sort((a, b) => a.t - b.t)
      .map((o) => ({ t: round(o.t), band: o.band, soft: o.soft, inst: o.inst }));
    return {
      id: this.id,
      genre: this.genre,
      notes: this.notes,
      duration: this.secs,
      sampleRate: RATE,
      meter: this.meter,
      tempo: tempos[0],
      tempos,
      beats,
      downbeats,
      onsets,
    };
  }
}

function round(t) {
  return Math.round(t * 10000) / 10000;
}

export function mixArrays(list) {
  const n = Math.max(...list.map((a) => a.length));
  const out = new Float32Array(n);
  for (const a of list) for (let i = 0; i < a.length; i++) out[i] += a[i] / Math.sqrt(list.length);
  return out;
}
