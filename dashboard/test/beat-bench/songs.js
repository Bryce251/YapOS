import { Song, mixArrays } from './song.js';
import { hz, kick, snare, clap, hat, shaker, crash, tom, riser, note, piano, vocal } from './synth.js';

const PROG = {
  pop: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]],
  minor: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
  dark: [[50, 53, 57], [46, 50, 53], [48, 51, 55], [45, 48, 52]],
  jazz: [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71], [57, 60, 64, 67]],
};
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];

function chordOf(prog, bar, per = 1) {
  return prog[Math.floor(bar / per) % prog.length];
}

function pianoChord(s, dur, notes, o = {}) {
  return mixArrays(notes.map((m) => piano(s.r, dur, hz(m), o)));
}

function synthChord(s, dur, notes, o = {}) {
  return mixArrays(notes.map((m) => note(s.r, dur, hz(m), o)));
}

function melody(s, from, to, root, { step = 0.5, rest = 0.3, wave = 'square', gain = 0.16, cutoff = 2600, legato = false } = {}) {
  let pos = from * s.meter;
  const end = to * s.meter;
  let prev = null;
  while (pos < end) {
    const len = [step, step, step * 2, step * 3][Math.floor(s.r() * 4)];
    if (s.r() < rest) {
      pos += len;
      prev = null;
      continue;
    }
    const m = root + PENTA[Math.floor(s.r() * PENTA.length)];
    const dur = (60 / s.nominal) * len * (legato ? 1 : 0.85);
    s.play(pos, note(s.r, dur, hz(m), { wave, cutoff, attack: 0.008, decay: 0.1, sustain: 0.6, release: 0.06, vibrato: { depth: 0.15 } }), { gain, band: 'M', inst: 'lead', send: 0.2 });
    prev = m;
    pos += len;
  }
  return prev;
}

function pop118() {
  const s = new Song({ id: 'pop-118', genre: 'pop', bpm: 118, secs: 48, seed: 101, jitter: 8, notes: '4/4 drums, plucked bass, piano chords, square lead' });
  s.fx.wet = 0.25;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const ch = chordOf(PROG.pop, b);
    const o = b * 4;
    s.play(o, pianoChord(s, 1.1, ch), { gain: 0.5, band: 'M', inst: 'chords', send: 0.3 });
    s.play(o + 1.5, pianoChord(s, 0.9, ch), { gain: 0.4, band: 'M', inst: 'chords', send: 0.3 });
    if (b < 2) continue;
    for (let e = 0; e < 8; e++) {
      const p = o + e / 2;
      if (e === 0 || e === 4 || (e === 5 && b % 2)) s.play(p, kick(s.r), { gain: 0.9, band: 'L', inst: 'kick' });
      if (e === 2 || e === 6) s.play(p, snare(s.r), { gain: 0.55, band: 'M', inst: 'snare', send: 0.2 });
      s.play(p, hat(s.r), { gain: 0.16, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'hat' });
      s.play(p, note(s.r, 0.2, hz(ch[0] - 24), { wave: 'saw', cutoff: 300, filterEnv: 1500, filterDecay: 0.05, decay: 0.1, sustain: 0.5 }), { gain: 0.45, band: 'L', inst: 'bass' });
    }
  }
  melody(s, 6, bars, 72);
  return s;
}

function edm128() {
  const s = new Song({ id: 'edm-128', genre: 'edm', bpm: 128, secs: 52, seed: 202, jitter: 2, notes: 'four-on-the-floor, sidechained supersaw pad, 16th arp, breakdown' });
  s.fx.sidechain = 0.85;
  s.fx.wet = 0.2;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const ch = chordOf(PROG.minor, b, 2);
    const o = b * 4;
    const drums = b >= 4 && !(b >= 16 && b < 20);
    if (b % 2 === 0) s.play(o, synthChord(s, (60 / 128) * 8, ch, { wave: 'saw', voices: 5, detune: 18, attack: 0.35, release: 0.5, sustain: 1, cutoff: 2200 }), { gain: 0.5, bus: 'pad', band: 'M', soft: true, inst: 'pad', send: 0.3 });
    for (let q = 0; q < 16; q++) {
      const p = o + q / 4;
      const m = ch[q % 3] + 12 * (q % 8 >= 4 ? 1 : 0);
      s.play(p, note(s.r, 0.1, hz(m), { wave: 'saw', cutoff: 600, filterEnv: 4000, filterDecay: 0.04, decay: 0.06, sustain: 0.2 }), { gain: drums ? 0.14 : 0.2, band: 'M', inst: 'arp', send: 0.3 });
    }
    if (!drums) continue;
    for (let k = 0; k < 4; k++) {
      s.play(o + k, kick(s.r, { decay: 0.25 }), { gain: 1, band: 'L', inst: 'kick', kick: true });
      if (k % 2) s.play(o + k, clap(s.r), { gain: 0.5, band: 'M', inst: 'clap', send: 0.3 });
      s.play(o + k + 0.5, hat(s.r, { open: true }), { gain: 0.14, band: 'H', inst: 'ohat' });
      s.play(o + k + 0.5, note(s.r, 0.18, hz(ch[0] - 24), { wave: 'saw', cutoff: 250, filterEnv: 900, filterDecay: 0.06 }), { gain: 0.5, band: 'L', inst: 'bass' });
      if (b >= 8) for (const x of [0.25, 0.75]) s.play(o + k + x, hat(s.r), { gain: 0.06, band: 'H', soft: true, inst: 'hat' });
    }
  }
  return s;
}

function swing16(beat, step, amount) {
  return beat + (step % 2 ? step * 0.25 + (amount - 0.5) * 0.5 : step * 0.25);
}

function hiphop90() {
  const s = new Song({ id: 'hiphop-90', genre: 'hip-hop', bpm: 90, secs: 50, seed: 303, jitter: 12, notes: 'swung 16th hats, 808, rhodes' });
  s.fx.wet = 0.15;
  const bars = s.bars();
  const kicks = [[0, 0], [1, 2], [2, 0], [2, 3]];
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.jazz, b, 2);
    if (b % 2 === 0) s.play(o, pianoChord(s, (60 / 90) * 7, ch, { bright: 0.5, lp: 2500 }), { gain: 0.4, band: 'M', inst: 'rhodes', send: 0.3 });
    if (b < 1) continue;
    const pat = b % 4 === 3 ? [...kicks, [3, 1]] : kicks;
    for (const [beat, st] of pat) {
      const p = swing16(o + beat, st, 0.62);
      s.play(p, kick(s.r, { decay: 0.25 }), { gain: 0.9, band: 'L', inst: 'kick' });
    }
    s.play(o, note(s.r, (60 / 90) * 1.4, hz(ch[0] - 24), { wave: 'sine', attack: 0.004, sustain: 0.9, release: 0.2, glideFrom: b % 4 === 2 ? hz(ch[0] - 19) : null }), { gain: 0.6, band: 'L', inst: '808', onset: false });
    for (const beat of [1, 3]) {
      s.play(o + beat, mixArrays([snare(s.r, { tone: 210 }), clap(s.r)]), { gain: 0.6, band: 'M', inst: 'snare', send: 0.2 });
    }
    for (let beat = 0; beat < 4; beat++) for (let st = 0; st < 4; st++) {
      if (s.r() < 0.12) continue;
      s.play(swing16(o + beat, st, 0.62), hat(s.r), { gain: 0.13, vel: st === 0 ? 1 : st === 2 ? 0.75 : 0.45, band: 'H', soft: st % 2 === 1, inst: 'hat' });
    }
  }
  return s;
}

function rock165() {
  const s = new Song({ id: 'rock-165', genre: 'rock', bpm: 165, secs: 44, seed: 404, jitter: 10, notes: 'backbeat, 8th power chords, tom fills, crashes' });
  s.fx.wet = 0.2;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const root = [40, 43, 45, 38][Math.floor(b / 2) % 4];
    const chorus = Math.floor(b / 8) % 2 === 1;
    const fill = b % 4 === 3;
    if (b % 4 === 0 && b > 0) s.play(o, crash(s.r), { gain: 0.35, band: 'H', inst: 'crash', send: 0.3 });
    for (let e = 0; e < 8; e++) {
      const p = o + e / 2;
      if (fill && e >= 4) {
        for (const x of [0, 0.25]) s.play(p + x, tom(s.r, { f: [180, 150, 120, 100][e - 4] }), { gain: 0.6, band: 'M', inst: 'tom' });
        continue;
      }
      if (e === 0 || e === 5 || (e === 4 && chorus)) s.play(p, kick(s.r, { decay: 0.2 }), { gain: 0.9, band: 'L', inst: 'kick' });
      if (e === 2 || e === 6) s.play(p, snare(s.r, { tone: 200, noiseDecay: 0.2 }), { gain: 0.65, band: 'M', inst: 'snare', send: 0.25 });
      s.play(p, hat(s.r, { decay: 0.06 }), { gain: 0.12, vel: e % 2 ? 0.7 : 1, band: 'H', inst: 'ride' });
      if (!chorus) s.play(p, synthChord(s, 0.1, [root + 12, root + 19, root + 24], { wave: 'saw', drive: 4, cutoff: 1400 }), { gain: 0.35, band: 'M', inst: 'guitar' });
      s.play(p, note(s.r, 0.15, hz(root), { wave: 'saw', cutoff: 500, filterEnv: 800 }), { gain: 0.4, band: 'L', inst: 'bass' });
    }
    if (chorus) s.play(o, synthChord(s, (60 / 165) * 3.8, [root + 12, root + 19, root + 24], { wave: 'saw', drive: 6, cutoff: 2600, voices: 2, detune: 8 }), { gain: 0.4, band: 'M', inst: 'guitar', send: 0.2 });
  }
  return s;
}

function trap150() {
  const s = new Song({ id: 'trap-150', genre: 'trap', bpm: 150, secs: 44, seed: 505, jitter: 3, notes: 'half-time snare on 3, rolling hats (16th, 32nd, triplet), 808 glides' });
  s.fx.wet = 0.2;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const roll = b % 2 === 1;
    for (const p of [0, 1.75, 2.5]) s.play(o + p, kick(s.r, { decay: 0.2 }), { gain: 0.85, band: 'L', inst: 'kick' });
    s.play(o, note(s.r, (60 / 150) * 3.5, hz([38, 41, 36, 43][b % 4]), { wave: 'sine', attack: 0.003, sustain: 0.95, release: 0.2, drive: 2, glideFrom: b % 2 ? hz(50) : null }), { gain: 0.7, band: 'L', inst: '808', onset: false });
    s.play(o + 2, mixArrays([snare(s.r, { tone: 230 }), clap(s.r)]), { gain: 0.65, band: 'M', inst: 'snare', send: 0.3 });
    let p = 0;
    while (p < 4 - 1e-6) {
      let step = 0.5;
      if (roll && p >= 3) step = 0.125;
      else if (roll && p >= 2.5) step = 1 / 6;
      else if (p >= 1 && p < 2) step = 0.25;
      s.play(o + p, hat(s.r, { decay: 0.03 }), { gain: 0.15, vel: Math.abs(p - Math.round(p)) < 1e-6 ? 1 : 0.7, band: 'H', inst: 'hat', soft: step < 0.2 });
      p += step;
    }
    if (b % 2 === 0) for (const [x, m] of [[0, 74], [1.5, 77], [3, 72]]) s.play(o + x, note(s.r, 0.5, hz(m), { wave: 'tri', decay: 0.3, sustain: 0.1, attack: 0.002 }), { gain: 0.2, band: 'M', inst: 'bell', send: 0.4 });
  }
  return s;
}

function dnb174() {
  const s = new Song({ id: 'dnb-174', genre: 'drum and bass', bpm: 174, secs: 40, seed: 606, jitter: 3, notes: 'two-step break, reese bass, pad' });
  s.fx.wet = 0.25;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.dark, b, 2);
    if (b % 2 === 0) {
      s.play(o, synthChord(s, (60 / 174) * 8, ch.map((m) => m + 12), { wave: 'saw', voices: 3, attack: 0.4, sustain: 1, cutoff: 1500, release: 0.4 }), { gain: 0.3, band: 'M', inst: 'pad', soft: true, send: 0.4 });
      s.play(o, note(s.r, (60 / 174) * 7.5, hz(ch[0] - 24), { wave: 'saw', voices: 3, detune: 25, attack: 0.05, sustain: 1, cutoff: 260 }), { gain: 0.6, band: 'L', inst: 'reese', soft: true });
    }
    const kickPos = b % 4 === 3 ? [0, 2.5, 2.75] : [0, 2.5];
    for (const p of kickPos) s.play(o + p, kick(s.r, { decay: 0.15, f0: 180 }), { gain: 0.85, band: 'L', inst: 'kick' });
    for (const p of [1, 3]) s.play(o + p, snare(s.r, { tone: 220, noiseDecay: 0.12 }), { gain: 0.7, band: 'M', inst: 'snare', send: 0.2 });
    for (let q = 0; q < 16; q++) {
      const ghost = q % 2 === 1;
      if (ghost && s.r() < 0.5) continue;
      s.play(o + q / 4, hat(s.r, { decay: 0.025 }), { gain: 0.12, vel: ghost ? 0.4 : 1, band: 'H', inst: 'hat', soft: ghost });
    }
  }
  return s;
}

function lofi78() {
  const s = new Song({ id: 'lofi-78', genre: 'lo-fi', bpm: 78, secs: 50, seed: 707, jitter: 15, notes: 'soft lowpassed transients, swung hats, rhodes, vinyl noise' });
  s.fx.lp = 5000;
  s.fx.wet = 0.2;
  s.fx.noise = [['vinyl', 0.012, 10]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.jazz, b);
    s.play(o, pianoChord(s, (60 / 78) * 2.5, ch, { bright: 0.4, lp: 1600, attack: 120, soft: true }), { gain: 0.5, band: 'M', inst: 'rhodes', send: 0.3 });
    s.play(o + 2.5, pianoChord(s, (60 / 78) * 1.2, ch.slice(1), { bright: 0.4, lp: 1600, attack: 120, soft: true }), { gain: 0.35, band: 'M', inst: 'rhodes', send: 0.3 });
    s.play(o, note(s.r, 0.6, hz(ch[0] - 24), { wave: 'sine', attack: 0.01, decay: 0.3, sustain: 0.4 }), { gain: 0.5, band: 'L', inst: 'bass', onset: false });
    for (const p of [0, 1.5, 2.75]) s.play(o + p, kick(s.r, { click: 0.04, lp: 700, decay: 0.25 }), { gain: 0.8, band: 'L', inst: 'kick' });
    for (const p of [1, 3]) s.play(o + p, snare(s.r, { attack: 70, lp: 2500, noise: 0.6 }), { gain: 0.45, band: 'M', inst: 'snare', send: 0.3 });
    for (let e = 0; e < 8; e++) s.play(o + Math.floor(e / 2) + (e % 2 ? 0.58 : 0), hat(s.r, { hp: 5000 }), { gain: 0.07, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'hat', soft: e % 2 === 1 });
  }
  return s;
}

function drop124() {
  const s = new Song({ id: 'drop-124', genre: 'edm build and drop', bpm: 124, secs: 56, seed: 808, jitter: 3, notes: '8 quiet bars of pad and piano, 4 bar riser with snare roll, loud drop' });
  s.fx.sidechain = 0.8;
  s.fx.wet = 0.3;
  const bars = s.bars();
  s.playAt(s.at(32), riser(s.r, s.at(48) - s.at(32)), { gain: 0.25 });
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.minor, b, 2);
    if (b % 2 === 0) s.play(o, synthChord(s, (60 / 124) * 8, ch, { wave: 'saw', voices: 5, detune: 15, attack: 0.5, sustain: 1, release: 0.6, cutoff: b < 12 ? 900 : 2400 }), { gain: b < 12 ? 0.18 : 0.4, bus: 'pad', band: 'M', soft: true, inst: 'pad', send: 0.4 });
    if (b < 12) {
      for (let e = 0; e < 8; e++) s.play(o + e / 2, piano(s.r, 0.4, hz(ch[e % 3] + 12)), { gain: 0.08, band: 'M', inst: 'piano', send: 0.5 });
      if (b >= 8) {
        const div = b === 8 ? 1 : b === 9 ? 2 : 4;
        for (let k = 0; k < 4 * div; k++) s.play(o + k / div, snare(s.r, { noiseDecay: 0.08 }), { gain: 0.06 + 0.04 * (b - 8) + 0.02 * (k / (4 * div)), band: 'M', inst: 'snareroll' });
        for (let e = 0; e < 8; e++) s.play(o + e / 2, hat(s.r), { gain: 0.04, band: 'H', inst: 'hat', soft: true });
      }
      continue;
    }
    if (b === 12) s.play(o, crash(s.r), { gain: 0.4, band: 'H', inst: 'crash', send: 0.3 });
    for (let k = 0; k < 4; k++) {
      s.play(o + k, kick(s.r, { decay: 0.28 }), { gain: 1, band: 'L', inst: 'kick', kick: true });
      if (k % 2) s.play(o + k, clap(s.r), { gain: 0.55, band: 'M', inst: 'clap', send: 0.3 });
      for (const x of [0.25, 0.5, 0.75]) s.play(o + k + x, hat(s.r, { open: x === 0.5 }), { gain: x === 0.5 ? 0.14 : 0.07, band: 'H', inst: 'hat', soft: x !== 0.5 });
      s.play(o + k + 0.5, note(s.r, 0.2, hz(ch[0] - 24), { wave: 'saw', cutoff: 250, filterEnv: 1200 }), { gain: 0.5, band: 'L', inst: 'bass' });
    }
    for (const x of [0, 0.75, 1.5, 2.5, 3.25]) s.play(o + x, synthChord(s, 0.15, ch.map((m) => m + 12), { wave: 'saw', voices: 3, cutoff: 1200, filterEnv: 3000 }), { gain: 0.3, band: 'M', inst: 'stab', send: 0.3 });
  }
  return s;
}

function tempoChange() {
  const s = new Song({ id: 'tempo-change-100-128', genre: 'pop with tempo change', bpm: 100, secs: 54, seed: 909, jitter: 6, tempo: (i) => (i < 48 ? 100 : 128), notes: '12 bars at 100 BPM then 128 BPM with a crash' });
  s.fx.wet = 0.2;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.pop, b);
    if (b === 12) s.play(o, crash(s.r), { gain: 0.4, band: 'H', inst: 'crash' });
    s.play(o, pianoChord(s, 1.5, ch), { gain: 0.4, band: 'M', inst: 'chords', send: 0.3 });
    for (let e = 0; e < 8; e++) {
      const p = o + e / 2;
      if (e === 0 || e === 3 || e === 4) s.play(p, kick(s.r), { gain: 0.9, band: 'L', inst: 'kick' });
      if (e === 2 || e === 6) s.play(p, snare(s.r), { gain: 0.55, band: 'M', inst: 'snare', send: 0.2 });
      s.play(p, hat(s.r), { gain: 0.14, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'hat' });
      if (e % 2 === 0) s.play(p, note(s.r, 0.25, hz(ch[0] - 24), { wave: 'saw', cutoff: 300, filterEnv: 1000 }), { gain: 0.45, band: 'L', inst: 'bass' });
    }
  }
  return s;
}

function sixEight() {
  const s = new Song({ id: 'six-eight-76', genre: '6/8 ballad rock', bpm: 76, meter: 2, secs: 48, seed: 1010, jitter: 10, notes: '6/8, beat = dotted quarter (2 per bar), triplet eighths' });
  s.fx.wet = 0.25;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 2;
    const ch = chordOf(PROG.minor, b);
    s.play(o, kick(s.r), { gain: 0.85, band: 'L', inst: 'kick' });
    if (b % 2) s.play(o + 1 + 2 / 3, kick(s.r), { gain: 0.6, band: 'L', inst: 'kick' });
    s.play(o + 1, snare(s.r), { gain: 0.55, band: 'M', inst: 'snare', send: 0.3 });
    for (let e = 0; e < 6; e++) {
      const p = o + e / 3;
      s.play(p, hat(s.r), { gain: 0.11, vel: e % 3 === 0 ? 1 : 0.55, band: 'H', inst: 'hat' });
      s.play(p, piano(s.r, 0.5, hz(ch[[0, 1, 2, 1, 2, 1][e]] + 12)), { gain: 0.22, vel: e % 3 === 0 ? 1 : 0.7, band: 'M', inst: 'arp', send: 0.3 });
    }
    for (const x of [0, 1]) s.play(o + x, note(s.r, (60 / 76) * 0.9, hz(ch[0] - 24), { wave: 'saw', cutoff: 350, filterEnv: 700 }), { gain: 0.45, band: 'L', inst: 'bass' });
  }
  return s;
}

function funk104() {
  const s = new Song({ id: 'funk-104', genre: 'funk', bpm: 104, secs: 46, seed: 1111, jitter: 8, notes: 'syncopated 16th kick and slap bass, ghost snares, guitar scratches, horn stabs' });
  s.fx.wet = 0.15;
  const bars = s.bars();
  const kp = [[0, 3, 6, 10], [0, 7, 10, 13]];
  const bp = [[0, 46], [3, 46], [6, 58], [7, 46], [10, 49], [11, 51], [14, 53]];
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    for (const st of kp[b % 2]) s.play(o + st / 4, kick(s.r, { decay: 0.18 }), { gain: 0.85, band: 'L', inst: 'kick' });
    for (const st of [4, 12]) s.play(o + st / 4, snare(s.r, { tone: 240 }), { gain: 0.65, band: 'M', inst: 'snare', send: 0.15 });
    for (const st of [7, 9, 15]) if (s.r() < 0.7) s.play(o + st / 4, snare(s.r, { tone: 240 }), { gain: 0.12, band: 'M', inst: 'ghost', soft: true });
    for (let st = 0; st < 16; st++) {
      const open = st === 14;
      s.play(o + st / 4, hat(s.r, { open }), { gain: open ? 0.12 : 0.1, vel: st % 2 ? 0.45 : 1, band: 'H', inst: 'hat', soft: st % 2 === 1 && !open });
    }
    for (const [st, m] of bp) s.play(o + st / 4, note(s.r, 0.12, hz(m - 12), { wave: 'square', cutoff: 400, filterEnv: 3000, filterDecay: 0.03, decay: 0.08, sustain: 0.3 }), { gain: 0.45, band: 'L', inst: 'slap' });
    for (const st of [2, 6, 10, 14]) s.play(o + st / 4, synthChord(s, 0.04, [64, 67, 71], { wave: 'saw', cutoff: 3000, filterEnv: 2000 }), { gain: 0.18, band: 'M', inst: 'guitar' });
    if (b % 4 === 1) for (const st of [11, 14]) s.play(o + st / 4, synthChord(s, 0.15, [70, 74, 77], { wave: 'saw', voices: 3, cutoff: 2500, attack: 0.01 }), { gain: 0.3, band: 'M', inst: 'horns', send: 0.3 });
  }
  return s;
}

function noisy96() {
  const s = new Song({ id: 'noisy-96', genre: 'noisy mix', bpm: 96, secs: 48, seed: 1212, jitter: 10, notes: 'heavy reverb, vinyl crackle, crowd noise, buried hats' });
  s.fx.wet = 0.55;
  s.fx.size = 1.3;
  s.fx.noise = [['vinyl', 0.025, 15], ['crowd', 0.035]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.pop, b);
    s.play(o, pianoChord(s, 2.4, ch), { gain: 0.45, band: 'M', inst: 'chords', send: 1 });
    s.play(o + 2, pianoChord(s, 1.6, ch), { gain: 0.35, band: 'M', inst: 'chords', send: 1 });
    for (let e = 0; e < 8; e++) {
      const p = o + e / 2;
      if (e === 0 || e === 5 || (e === 4 && b % 2)) s.play(p, kick(s.r), { gain: 0.8, band: 'L', inst: 'kick', send: 0.3 });
      if (e === 2 || e === 6) s.play(p, snare(s.r), { gain: 0.5, band: 'M', inst: 'snare', send: 1 });
      s.play(p, hat(s.r), { gain: 0.06, band: 'H', inst: 'hat', soft: true, send: 0.5 });
    }
    s.play(o, note(s.r, 1.2, hz(ch[0] - 24), { wave: 'saw', cutoff: 300 }), { gain: 0.35, band: 'L', inst: 'bass' });
  }
  return s;
}

function ballad72() {
  const r0 = (i) => 72 * (1 + 0.016 * Math.sin((2 * Math.PI * i) / 23) + 0.006 * Math.sin((2 * Math.PI * i) / 7.3 + 1));
  const s = new Song({ id: 'ballad-72-rubato', genre: 'piano ballad', bpm: 72, secs: 56, seed: 1313, jitter: 15, tempo: r0, notes: 'solo piano, tempo drifts +-2 percent, dynamic swells' });
  s.fx.wet = 0.35;
  s.fx.size = 1.2;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.pop, b);
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * b) / 8);
    s.play(o, piano(s.r, 2.5, hz(ch[0] - 24)), { gain: 0.6 * swell, band: 'L', inst: 'lh-bass', send: 0.5 });
    for (let e = 1; e < 8; e++) s.play(o + e / 2, piano(s.r, 0.6, hz(ch[e % 3] - 12)), { gain: 0.22 * swell, band: 'M', inst: 'lh-arp', send: 0.5, soft: e % 2 === 1 });
    let p = 0;
    while (p < 4) {
      const len = [1, 1, 0.5, 2][Math.floor(s.r() * 4)];
      if (s.r() > 0.2) s.play(o + p, piano(s.r, len * 0.8, hz(ch[0] + 12 + PENTA[Math.floor(s.r() * 6)])), { gain: 0.45 * swell, band: 'M', inst: 'melody', send: 0.5 });
      p += len;
    }
  }
  return s;
}

function silenceStart() {
  const s = new Song({ id: 'silence-start-120', genre: 'electro pop', bpm: 120, secs: 46, seed: 1414, jitter: 5, start: 6.3, notes: '6.3 s of digital silence before the music' });
  s.fx.wet = 0.2;
  s.silentUntil = 6.3 - 0.002;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.minor, b);
    for (const p of [0, 1.5, 2]) s.play(o + p, kick(s.r), { gain: 0.9, band: 'L', inst: 'kick' });
    for (const p of [1, 3]) s.play(o + p, clap(s.r), { gain: 0.55, band: 'M', inst: 'clap', send: 0.3 });
    for (let q = 0; q < 16; q++) s.play(o + q / 4, hat(s.r), { gain: 0.09, vel: q % 4 === 0 ? 1 : 0.6, band: 'H', inst: 'hat', soft: q % 2 === 1 });
    for (const p of [0, 0.75, 1.5, 2.5, 3]) s.play(o + p, synthChord(s, 0.2, ch, { wave: 'square', cutoff: 900, filterEnv: 2500 }), { gain: 0.25, band: 'M', inst: 'pluck', send: 0.3 });
    for (let e = 0; e < 8; e++) s.play(o + e / 2, note(s.r, 0.18, hz(ch[0] - 24), { wave: 'saw', cutoff: 280, filterEnv: 900 }), { gain: 0.4, band: 'L', inst: 'bass' });
  }
  return s;
}

function heavyBass100() {
  const s = new Song({ id: 'heavy-bass-100', genre: 'bass music', bpm: 100, secs: 48, seed: 1515, jitter: 6, notes: 'loud sustained sub and wobble bass, weak kick transient, very quiet hats' });
  s.fx.wet = 0.1;
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const root = [33, 33, 36, 31][Math.floor(b / 2) % 4];
    if (b % 2 === 0) {
      const wob = Math.floor(b / 4) % 2 === 1;
      const dur = (60 / 100) * 7.8;
      const arr = note(s.r, dur, hz(root), { wave: 'saw', voices: 2, detune: 10, attack: 0.02, sustain: 1, drive: 2 });
      if (wob) {
        const period = 60 / 100 / 2;
        for (let i = 0; i < arr.length; i++) arr[i] *= 0.25 + 0.75 * (0.5 + 0.5 * Math.cos((2 * Math.PI * i) / (period * 44100)));
      }
      s.play(o, arr, { gain: 0.5, band: 'L', inst: 'wobble', soft: true, onset: b % 4 === 0 });
      s.play(o, note(s.r, dur, hz(root - 12), { wave: 'sine', attack: 0.03, sustain: 1, release: 0.3 }), { gain: 0.9, band: 'L', inst: 'sub', onset: false });
    }
    for (const p of [0, 2.5]) s.play(o + p, kick(s.r, { f0: 90, f1: 45, click: 0.05, decay: 0.2 }), { gain: 0.6, band: 'L', inst: 'kick' });
    s.play(o + 2, snare(s.r, { noiseDecay: 0.1 }), { gain: 0.25, band: 'M', inst: 'snare' });
    for (let e = 0; e < 8; e++) s.play(o + e / 2, hat(s.r), { gain: 0.035, band: 'H', inst: 'hat', soft: true });
  }
  return s;
}

function vocal84() {
  const s = new Song({ id: 'vocal-84', genre: 'vocal ballad', bpm: 84, secs: 50, seed: 1616, jitter: 12, notes: 'legato vocal-like lead with glides and vibrato, soft pad, very few drum hits' });
  s.fx.wet = 0.35;
  const bars = s.bars();
  const vowels = ['a', 'o', 'e', 'u', 'i'];
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = chordOf(PROG.minor, b, 2);
    if (b % 2 === 0) s.play(o, synthChord(s, (60 / 84) * 8, ch, { wave: 'tri', voices: 2, attack: 0.6, sustain: 1, release: 0.8, cutoff: 1500 }), { gain: 0.25, band: 'M', inst: 'pad', soft: true, send: 0.5 });
    if (b >= 2) s.play(o, kick(s.r, { decay: 0.3, click: 0.1 }), { gain: 0.7, band: 'L', inst: 'kick' });
    if (b >= 2 && b % 2 === 1) s.play(o + 2, snare(s.r, { tone: 330, noiseDecay: 0.05, noise: 0.5 }), { gain: 0.35, band: 'M', inst: 'rim', send: 0.3 });
    if (b >= 8 && b < 12) for (let k = 0; k < 4; k++) s.play(o + k + 0.5, shaker(s.r), { gain: 0.08, band: 'H', inst: 'shaker' });
  }
  let pos = 4;
  let prev = null;
  while (pos < bars * 4) {
    const len = [0.5, 1, 1, 1.5, 2][Math.floor(s.r() * 5)];
    if (s.r() < 0.18) {
      pos += len + 0.5;
      prev = null;
      continue;
    }
    const m = 64 + PENTA[Math.floor(s.r() * 6)];
    const dur = (60 / 84) * len;
    s.play(pos, vocal(s.r, dur, hz(m), { vowel: vowels[Math.floor(s.r() * 5)], glideFrom: prev ? hz(prev) : null, attack: prev ? 0.03 : 0.08 }), { gain: 0.5, band: 'M', inst: 'vocal', soft: true, send: 0.4 });
    prev = m;
    pos += len;
  }
  return s;
}

export const SONGS = [pop118, edm128, hiphop90, rock165, trap150, dnb174, lofi78, drop124, tempoChange, sixEight, funk104, noisy96, ballad72, silenceStart, heavyBass100, vocal84];

export function buildSong(fn) {
  return finishSong(fn());
}

export function finishSong(s) {
  if (s.silentUntil) s.firstBeat = s.beats.findIndex((t) => t >= s.silentUntil);
  const pcm = s.render();
  return { pcm, sampleRate: 44100, truth: s.truth() };
}
