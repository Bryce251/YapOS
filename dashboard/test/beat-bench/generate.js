import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SONGS, finishSong } from './songs.js';
import { writeWav, encode, hasFfmpeg } from './audio.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const o = { out: join(HERE, 'out'), only: null, formats: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--only') o.only = argv[++i].split(',');
    else if (argv[i] === '--formats') o.formats = argv[++i].split(',');
  }
  return o;
}

export function generate({ out = join(HERE, 'out'), only = null, formats = null, log = console.log } = {}) {
  mkdirSync(out, { recursive: true });
  const ff = hasFfmpeg();
  const want = (formats || (ff ? ['wav', 'mp3', 'ogg'] : ['wav'])).filter((f) => f === 'wav' || ff);
  const manifest = [];
  for (const fn of SONGS) {
    const t0 = performance.now();
    const song = fn();
    if (only && !only.includes(song.id)) continue;
    const { pcm, sampleRate, truth } = finishSong(song);
    const base = join(out, truth.id);
    writeWav(`${base}.wav`, pcm, sampleRate);
    for (const f of want) if (f !== 'wav') encode(`${base}.wav`, `${base}.${f}`, f);
    writeFileSync(`${base}.truth.json`, JSON.stringify(truth));
    manifest.push({ id: truth.id, genre: truth.genre, tempo: truth.tempo, tempos: truth.tempos, meter: truth.meter, duration: truth.duration, beats: truth.beats.length, onsets: truth.onsets.filter((o) => !o.soft).length, softOnsets: truth.onsets.filter((o) => o.soft).length, formats: want, notes: truth.notes });
    log(`${truth.id.padEnd(22)} ${String(truth.tempos.join('/')).padEnd(10)} ${truth.duration}s  ${truth.beats.length} beats  ${manifest.at(-1).onsets} onsets (+${manifest.at(-1).softOnsets} soft)  ${Math.round(performance.now() - t0)} ms`);
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const o = args(process.argv.slice(2));
  generate(o);
}
