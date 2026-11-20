export function resample(pcm, from, to, taps = 16) {
  if (from === to) return Float32Array.from(pcm);
  const ratio = to / from;
  const n = Math.floor(pcm.length * ratio);
  const out = new Float32Array(n);
  const cut = Math.min(1, ratio) * 0.95;
  const step = 1 / ratio;
  for (let i = 0; i < n; i++) {
    const c = i * step;
    const c0 = Math.floor(c);
    let s = 0;
    let w = 0;
    for (let k = c0 - taps + 1; k <= c0 + taps; k++) {
      if (k < 0 || k >= pcm.length) continue;
      const x = c - k;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cut * x) / (Math.PI * cut * x);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / taps);
      const h = cut * sinc * win;
      s += pcm[k] * h;
      w += h;
    }
    out[i] = w ? s / w : 0;
  }
  return out;
}
