import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Song, mixArrays } from './song.js';
import { hz, kick, snare, hat, shaker, crash, note, piano } from './synth.js';
import { finishSong } from './songs.js';
import { writeWav, encode, hasFfmpeg } from './audio.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function chord(s, dur, notes, o = {}) {
  return mixArrays(notes.map((m) => note(s.r, dur, hz(m), o)));
}

function reggae76() {
  const s = new Song({ id: 'reggae-76', genre: 'reggae one drop', bpm: 76, secs: 50, seed: 7001, jitter: 9, notes: 'one drop: kick and rim only on beat 3, offbeat skank chords on every and, melodic bass' });
  s.fx.wet = 0.3;
  const prog = [[57, 60, 64], [62, 65, 69], [55, 59, 62], [60, 64, 67]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = prog[b % 4];
    for (let k = 0; k < 4; k++) s.play(o + k + 0.5, chord(s, 0.09, ch.map((m) => m + 12), { wave: 'square', cutoff: 2800, decay: 0.05, sustain: 0.3, attack: 0.002 }), { gain: 0.3, band: 'M', inst: 'skank', send: 0.35 });
    if (b >= 1) {
      s.play(o + 2, kick(s.r, { decay: 0.25, f0: 120 }), { gain: 0.85, band: 'L', inst: 'kick' });
      s.play(o + 2, snare(s.r, { tone: 420, noiseDecay: 0.05, noise: 0.4 }), { gain: 0.45, band: 'M', inst: 'rim', send: 0.4 });
      for (let e = 0; e < 8; e++) s.play(o + e / 2, hat(s.r, { decay: 0.03 }), { gain: 0.08, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'hat', soft: e % 2 === 1 });
    }
    for (const [p, d] of [[0, 0.9], [1.5, 0.4], [2.5, 0.4], [3, 0.8]]) s.play(o + p, note(s.r, (60 / 76) * d, hz(ch[(p * 2) % 3] - 24), { wave: 'sine', attack: 0.01, decay: 0.2, sustain: 0.7, drive: 1.5 }), { gain: 0.55, band: 'L', inst: 'bass' });
    if (b % 4 === 3) s.play(o + 3.5, crash(s.r, { decay: 0.6 }), { gain: 0.08, band: 'H', inst: 'cym' });
  }
  return s;
}

function metal200() {
  const s = new Song({ id: 'metal-200', genre: 'metal', bpm: 200, secs: 40, seed: 7002, jitter: 4, notes: 'double kick 8ths at 200 BPM, snare on 2 and 4, crash every bar, distorted palm muted riffs' });
  s.fx.wet = 0.15;
  const roots = [40, 40, 43, 38];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const r0 = roots[b % 4];
    if (b < 2) {
      s.play(o, chord(s, (60 / 200) * 7.5, [r0, r0 + 7, r0 + 12], { wave: 'saw', drive: 6, cutoff: 3000, sustain: 0.9 }), { gain: 0.35, band: 'M', inst: 'guitar', send: 0.2 });
      for (let k = 0; k < 4; k++) s.play(o + k, hat(s.r, { open: true, decay: 0.15 }), { gain: 0.12, band: 'H', inst: 'ride' });
      continue;
    }
    for (let e = 0; e < 8; e++) {
      s.play(o + e / 2, kick(s.r, { decay: 0.08, f0: 200, click: 0.6 }), { gain: 0.8, band: 'L', inst: 'kick' });
      s.play(o + e / 2, chord(s, 0.11, [r0, r0 + 7], { wave: 'saw', drive: 8, cutoff: 900, decay: 0.05, sustain: 0.5 }), { gain: 0.25, band: 'M', inst: 'palm' });
    }
    for (const p of [1, 3]) s.play(o + p, snare(s.r, { tone: 210 }), { gain: 0.7, band: 'M', inst: 'snare', send: 0.25 });
    s.play(o, crash(s.r, { decay: 0.9 }), { gain: 0.18, band: 'H', inst: 'crash' });
    for (const p of [1, 2, 3]) s.play(o + p, hat(s.r, { decay: 0.06 }), { gain: 0.1, band: 'H', inst: 'hat' });
  }
  return s;
}

function ambient64() {
  const s = new Song({ id: 'ambient-64', genre: 'ambient', bpm: 64, secs: 56, seed: 7003, jitter: 12, notes: 'long soft pads, soft lowpassed kick on 1 and 3, quiet shaker, sparse soft piano' });
  s.fx.wet = 0.5;
  s.fx.size = 1.4;
  const prog = [[52, 59, 64, 67], [48, 55, 60, 64], [53, 60, 65, 69], [50, 57, 62, 65]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = prog[b % 4];
    s.play(o, chord(s, (60 / 64) * 4, ch, { wave: 'saw', voices: 3, detune: 15, attack: 0.9, release: 1.2, sustain: 1, cutoff: 1100 }), { gain: 0.5, band: 'M', inst: 'pad', soft: true, send: 0.6 });
    if (b >= 2) {
      for (const p of [0, 2]) s.play(o + p, kick(s.r, { decay: 0.35, click: 0.05, lp: 500 }), { gain: 0.6, band: 'L', inst: 'kick', send: 0.2 });
      for (let e = 0; e < 8; e++) s.play(o + e / 2, shaker(s.r), { gain: 0.05, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'shaker', soft: true });
    }
    for (let k = 0; k < 4; k++) if (s.r() < 0.55) s.play(o + k, piano(s.r, 1.4, hz(ch[Math.floor(s.r() * 4)] + 12), { soft: true, bright: 0.5, attack: 120 }), { gain: 0.28, band: 'M', inst: 'piano', send: 0.7 });
  }
  return s;
}

function jungle165() {
  const s = new Song({ id: 'jungle-165', genre: 'jungle', bpm: 165, secs: 42, seed: 7004, jitter: 6, notes: 'chopped breakbeat with ghost snares and syncopated kicks, ride, rolling sub bass' });
  s.fx.wet = 0.2;
  const breaks = [
    [[0, 'k'], [0.5, 'k'], [1, 's'], [1.75, 'g'], [2.25, 'g'], [2.5, 'k'], [3, 's'], [3.5, 'g'], [3.75, 's']],
    [[0, 'k'], [0.5, 'k'], [1, 's'], [1.75, 'g'], [2.25, 'g'], [2.5, 'k'], [2.75, 'k'], [3.25, 's'], [3.75, 'g']],
  ];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const root = [38, 38, 41, 36][b % 4];
    if (b % 2 === 0) s.play(o, note(s.r, (60 / 165) * 7.5, hz(root - 12), { wave: 'sine', attack: 0.02, sustain: 1, drive: 1.3 }), { gain: 0.6, band: 'L', inst: 'sub', soft: true });
    const pat = b % 4 === 3 ? breaks[1] : breaks[0];
    for (const [p, kind] of pat) {
      if (kind === 'k') s.play(o + p, kick(s.r, { decay: 0.12, f0: 170 }), { gain: 0.8, band: 'L', inst: 'kick' });
      else if (kind === 's') s.play(o + p, snare(s.r, { tone: 240, noiseDecay: 0.1 }), { gain: 0.65, band: 'M', inst: 'snare', send: 0.2 });
      else s.play(o + p, snare(s.r, { tone: 240, noiseDecay: 0.05 }), { gain: 0.65, vel: 0.35, band: 'M', inst: 'ghost', soft: true });
    }
    for (let e = 0; e < 8; e++) s.play(o + e / 2, hat(s.r, { decay: 0.09, hp: 6000 }), { gain: 0.09, vel: e % 2 ? 0.7 : 1, band: 'H', inst: 'ride' });
    if (b % 8 === 0) s.play(o, crash(s.r), { gain: 0.15, band: 'H', inst: 'crash' });
  }
  return s;
}

function disco116() {
  const s = new Song({ id: 'disco-116', genre: 'disco', bpm: 116, secs: 46, seed: 8001, jitter: 5, notes: 'four on the floor, open hats on the and, octave bass, string stabs' });
  s.fx.wet = 0.25;
  const prog = [[57, 60, 64], [55, 59, 62], [53, 57, 60], [52, 55, 59]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = prog[b % 4];
    for (let k = 0; k < 4; k++) {
      s.play(o + k, kick(s.r, { decay: 0.22 }), { gain: 0.85, band: 'L', inst: 'kick' });
      if (k % 2) s.play(o + k, snare(s.r, { tone: 200 }), { gain: 0.5, band: 'M', inst: 'snare', send: 0.3 });
      s.play(o + k + 0.5, hat(s.r, { open: true, decay: 0.12 }), { gain: 0.13, band: 'H', inst: 'ohat' });
      for (const x of [0, 0.5]) s.play(o + k + x, note(s.r, 0.15, hz(ch[0] - 24 + (x ? 12 : 0)), { wave: 'saw', cutoff: 500, filterEnv: 1200, filterDecay: 0.05 }), { gain: 0.4, band: 'L', inst: 'bass' });
    }
    if (b % 2 === 1) for (const p of [1.5, 3.5]) s.play(o + p, chord(s, 0.18, ch.map((m) => m + 12), { wave: 'saw', voices: 3, cutoff: 3500, attack: 0.005 }), { gain: 0.22, band: 'M', inst: 'strings', send: 0.4 });
  }
  return s;
}

function waltz96() {
  const s = new Song({ id: 'waltz-96', genre: 'waltz', bpm: 96, meter: 3, secs: 48, seed: 8002, jitter: 10, notes: '3/4 oom-pah-pah: bass note on 1, piano chords on 2 and 3, brush snare' });
  s.fx.wet = 0.3;
  const prog = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 3;
    const ch = prog[b % 4];
    s.play(o, piano(s.r, 0.6, hz(ch[0] - 24)), { gain: 0.6, band: 'L', inst: 'bass', send: 0.2 });
    if (b >= 2) s.play(o, kick(s.r, { decay: 0.2, click: 0.1 }), { gain: 0.5, band: 'L', inst: 'kick' });
    for (const p of [1, 2]) {
      s.play(o + p, mixArrays(ch.map((m) => piano(s.r, 0.35, hz(m)))), { gain: 0.35, band: 'M', inst: 'chords', send: 0.3 });
      if (b >= 2) s.play(o + p, snare(s.r, { noiseDecay: 0.08, noise: 0.6, tone: 300 }), { gain: 0.18, band: 'H', inst: 'brush' });
    }
    if (b % 2 === 1) s.play(o + 2.5, piano(s.r, 0.3, hz(ch[2] + 12)), { gain: 0.2, band: 'M', inst: 'melody', send: 0.4 });
  }
  return s;
}

function synthwave100() {
  const s = new Song({ id: 'synthwave-100', genre: 'synthwave', bpm: 100, secs: 48, seed: 8003, jitter: 2, notes: 'big gated snare on 2 and 4, kick on 1 and 3, 16th arp, pad, slow intro' });
  s.fx.wet = 0.35;
  s.fx.size = 1.2;
  const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = prog[b % 4];
    s.play(o, chord(s, (60 / 100) * 4, ch, { wave: 'saw', voices: 4, detune: 14, attack: 0.3, sustain: 1, release: 0.4, cutoff: 1800 }), { gain: 0.35, band: 'M', inst: 'pad', soft: true, send: 0.4 });
    for (let q = 0; q < 16; q++) s.play(o + q / 4, note(s.r, 0.09, hz(ch[q % 3] + 12), { wave: 'square', cutoff: 1500, filterEnv: 2500, filterDecay: 0.03, decay: 0.05, sustain: 0.2 }), { gain: b < 2 ? 0.16 : 0.1, band: 'M', inst: 'arp', send: 0.3 });
    if (b < 2) continue;
    for (const p of [0, 2]) s.play(o + p, kick(s.r, { decay: 0.3 }), { gain: 0.9, band: 'L', inst: 'kick' });
    for (const p of [1, 3]) s.play(o + p, snare(s.r, { noiseDecay: 0.25, tone: 180 }), { gain: 0.6, band: 'M', inst: 'snare', send: 0.8 });
    for (let e = 0; e < 8; e++) s.play(o + e / 2, hat(s.r), { gain: 0.08, band: 'H', inst: 'hat' });
  }
  return s;
}

function bossa132() {
  const s = new Song({ id: 'bossa-132', genre: 'bossa nova', bpm: 132, secs: 44, seed: 8004, jitter: 10, notes: 'bossa clave rim clicks, soft kick on 1 and the and of 2, nylon guitar chord comping, shaker 8ths' });
  s.fx.wet = 0.2;
  const prog = [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71], [57, 60, 64, 67]];
  const clave = [0, 1.5, 3, 5, 6.5];
  const bars = s.bars();
  for (let b = 0; b < bars; b++) {
    const o = b * 4;
    const ch = prog[Math.floor(b / 2) % 4];
    for (const p of [0, 1.5, 2, 3.5]) s.play(o + p, kick(s.r, { decay: 0.18, click: 0.05, lp: 700 }), { gain: 0.55, vel: p % 2 === 0 ? 1 : 0.7, band: 'L', inst: 'kick' });
    for (const c of clave) if (c >= (b % 2) * 4 && c < (b % 2) * 4 + 4) s.play(o + c - (b % 2) * 4, snare(s.r, { tone: 800, noiseDecay: 0.02, noise: 0.3 }), { gain: 0.3, band: 'M', inst: 'rim' });
    for (const p of [0, 1, 1.5, 2.5, 3]) s.play(o + p, mixArrays(ch.map((m) => piano(s.r, 0.25, hz(m), { bright: 0.6 }))), { gain: 0.3, band: 'M', inst: 'guitar', send: 0.2 });
    for (let e = 0; e < 8; e++) s.play(o + e / 2, shaker(s.r), { gain: 0.08, vel: e % 2 ? 0.6 : 1, band: 'H', inst: 'shaker', soft: e % 2 === 1 });
  }
  return s;
}

export const HELDOUT = [reggae76, metal200, ambient64, jungle165];
export const HELDOUT2 = [disco116, waltz96, synthwave100, bossa132];

export function generateHeldout({ out = join(HERE, 'out-heldout'), set = HELDOUT, log = console.log } = {}) {
  mkdirSync(out, { recursive: true });
  const ff = hasFfmpeg();
  const manifest = [];
  for (const fn of set) {
    const { pcm, sampleRate, truth } = finishSong(fn());
    const base = join(out, truth.id);
    writeWav(`${base}.wav`, pcm, sampleRate);
    if (ff) for (const f of ['mp3', 'ogg']) encode(`${base}.wav`, `${base}.${f}`, f);
    writeFileSync(`${base}.truth.json`, JSON.stringify(truth));
    manifest.push({ id: truth.id, genre: truth.genre, tempo: truth.tempo, tempos: truth.tempos, meter: truth.meter, duration: truth.duration });
    log(`${truth.id.padEnd(22)} ${truth.tempos.join('/')}  ${truth.beats.length} beats  ${truth.onsets.filter((o) => !o.soft).length} onsets`);
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  generateHeldout();
  generateHeldout({ out: join(HERE, 'out-heldout2'), set: HELDOUT2 });
}
