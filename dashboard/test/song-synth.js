export const RATE = 22050;

function noise(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x >>> 8) / 8388608 - 1;
  };
}

export function clickTrack(bpm, secs = 40, start = 0.5) {
  const pcm = new Float32Array(RATE * secs);
  const rnd = noise(7);
  const p = 60 / bpm;
  const beats = [];
  for (let b = start; b < secs - 0.2; b += p) {
    beats.push(b * 1000);
    const s0 = Math.round(b * RATE);
    for (let i = 0; i < 300; i++) pcm[s0 + i] += rnd() * Math.exp(-i / 60);
  }
  return { pcm, beats };
}

export function drumLoop(bpm, secs = 64, { loudFrom = null, sustains = [] } = {}) {
  const pcm = new Float32Array(RATE * secs);
  const rnd = noise(11);
  const p = 60 / bpm;
  const start = 0.5;
  let prevHat = 0;
  const hits = { kick: [], snare: [], hat: [] };
  for (let k = 0, b = start; b < secs - 0.3; k++, b += p / 2) {
    const s0 = Math.round(b * RATE);
    const loud = loudFrom !== null && b >= loudFrom ? 1 : loudFrom !== null ? 0.35 : 1;
    const beat = k % 2 === 0;
    const pos = Math.floor(k / 2) % 4;
    if (beat && (pos === 0 || pos === 2)) {
      hits.kick.push(b * 1000);
      for (let i = 0; i < 3000; i++) pcm[s0 + i] += loud * 0.9 * Math.sin((2 * Math.PI * 60 * i) / RATE) * Math.exp(-i / 900);
    }
    if (beat && (pos === 1 || pos === 3)) {
      hits.snare.push(b * 1000);
      let last = 0;
      for (let i = 0; i < 2500; i++) {
        const w = rnd();
        pcm[s0 + i] += loud * 0.5 * (Math.sin((2 * Math.PI * 200 * i) / RATE) * 0.25 + (w - last) * 0.45) * Math.exp(-i / 700);
        last = w;
      }
    }
    hits.hat.push(b * 1000);
    for (let i = 0; i < 500; i++) {
      const w = rnd();
      pcm[s0 + i] += loud * 0.35 * (w - prevHat) * Math.exp(-i / 90);
      prevHat = w;
    }
    if (loudFrom !== null && b >= loudFrom) {
      const s1 = Math.round((b + p / 4) * RATE);
      for (let i = 0; i < 400; i++) {
        const w = rnd();
        pcm[s1 + i] += 0.3 * (w - prevHat) * Math.exp(-i / 80);
        prevHat = w;
      }
    }
  }
  for (const [at, len] of sustains) {
    const s0 = Math.round(at * RATE);
    const n = Math.round(len * RATE);
    for (let i = 0; i < n; i++) pcm[s0 + i] += 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) * Math.min(1, i / 40, (n - i) / 200);
  }
  return { pcm, hits, start, p };
}

export function swingLoop(bpm, secs = 40) {
  const pcm = new Float32Array(RATE * secs);
  const rnd = noise(23);
  const p = 60 / bpm;
  const start = 0.5;
  let prev = 0;
  const hits = { kick: [], snare: [], hat: [] };
  for (let k = 0, b = start; b < secs - 0.5; k++, b += p) {
    const s0 = Math.round(b * RATE);
    if (k % 2 === 0) {
      hits.kick.push(b * 1000);
      for (let i = 0; i < 3000; i++) pcm[s0 + i] += 0.9 * Math.sin((2 * Math.PI * 60 * i) / RATE) * Math.exp(-i / 900);
    } else {
      hits.snare.push(b * 1000);
      for (let i = 0; i < 2500; i++) pcm[s0 + i] += 0.4 * rnd() * Math.exp(-i / 600);
    }
    for (const at of [b, b + (2 * p) / 3]) {
      hits.hat.push(at * 1000);
      const s1 = Math.round(at * RATE);
      const g = at === b ? 0.35 : 0.3;
      for (let i = 0; i < 500; i++) {
        const w = rnd();
        pcm[s1 + i] += g * (w - prev) * Math.exp(-i / 90);
        prev = w;
      }
    }
  }
  return { pcm, hits, bpm, p };
}

export function shuffleLoop(bpm, secs = 40, ratio = 0.62) {
  const pcm = new Float32Array(RATE * secs);
  const rnd = noise(31);
  const p = 60 / bpm;
  const start = 0.5;
  let prev = 0;
  const hits = { kick: [], snare: [], hat: [] };
  for (let k = 0, b = start; b < secs - 0.5; k++, b += p) {
    const s0 = Math.round(b * RATE);
    if (k % 2 === 0) {
      hits.kick.push(b * 1000);
      for (let i = 0; i < 3000; i++) pcm[s0 + i] += 0.9 * Math.sin((2 * Math.PI * 60 * i) / RATE) * Math.exp(-i / 900);
    } else {
      hits.snare.push(b * 1000);
      for (let i = 0; i < 2500; i++) pcm[s0 + i] += 0.4 * rnd() * Math.exp(-i / 600);
    }
    for (const [at, g] of [[0, 0.35], [ratio / 2, 0.3], [0.5, 0.32], [0.5 + ratio / 2, 0.3]]) {
      const t = b + at * p;
      hits.hat.push(t * 1000);
      const s1 = Math.round(t * RATE);
      for (let i = 0; i < 450; i++) {
        const w = rnd();
        pcm[s1 + i] += g * (w - prev) * Math.exp(-i / 80);
        prev = w;
      }
    }
  }
  return { pcm, hits, bpm, p };
}
