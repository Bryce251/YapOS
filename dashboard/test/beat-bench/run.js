import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, pickAudio } from './audio.js';
import { scoreSong, summarize, WEIGHTS } from './score.js';
import { generate } from './generate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `usage: node test/beat-bench/run.js [options]
  --detector <file>   detector module exporting analyze(mono, sampleRate) (default detectors/current.js)
  --dir <dir>         songs folder (default test/beat-bench/out, generated when missing)
  --format <f>        mp3 | ogg | wav (default mp3 when ffmpeg exists, else wav)
  --only <a,b>        only these song ids
  --json <file>       also write full results as JSON
  --compare <file>    JSON from an earlier run to diff against
  --regen             regenerate the songs first`;

function args(argv) {
  const o = { detector: join(HERE, 'detectors', 'current.js'), dir: join(HERE, 'out'), format: null, only: null, json: null, compare: null, regen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detector') o.detector = resolve(argv[++i]);
    else if (a === '--dir') o.dir = resolve(argv[++i]);
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--json') o.json = resolve(argv[++i]);
    else if (a === '--compare') o.compare = resolve(argv[++i]);
    else if (a === '--regen') o.regen = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const pct = (v) => (v == null || !Number.isFinite(v) ? '   -' : String(Math.round(v * 100)).padStart(4));
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));

export async function runBench({ detector, dir, format = null, only = null, log = console.log }) {
  const mod = await import(pathToFileURL(detector).href);
  const analyze = mod.analyze || mod.default;
  if (typeof analyze !== 'function') throw new Error(`${detector} does not export analyze(mono, sampleRate)`);
  const ids = readdirSync(dir).filter((f) => f.endsWith('.truth.json')).map((f) => f.slice(0, -'.truth.json'.length)).filter((id) => !only || only.includes(id)).sort();
  const order = JSON.parse(existsSync(join(dir, 'manifest.json')) ? readFileSync(join(dir, 'manifest.json'), 'utf8') : '[]').map((m) => m.id);
  ids.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  const rows = [];
  for (const id of ids) {
    const truth = JSON.parse(readFileSync(join(dir, `${id}.truth.json`), 'utf8'));
    const file = pickAudio(join(dir, id), format);
    if (!file) throw new Error(`no playable audio for ${id}`);
    const { pcm, sampleRate } = decode(file, truth.sampleRate);
    const t0 = performance.now();
    const result = await analyze(pcm, sampleRate);
    const ms = performance.now() - t0;
    const duration = pcm.length / sampleRate;
    rows.push({ id, file: file.split(/[\\/]/).pop(), duration, ms, truth: { tempo: truth.tempo, tempos: truth.tempos }, result: { bpm: result.bpm, beats: (result.beats || []).length, onsets: (result.onsets || []).length }, s: scoreSong(truth, result, duration) });
  }
  return { detector: mod.name || detector, rows, summary: summarize(rows) };
}

export function table({ detector, rows, summary }, compare = null) {
  const prev = compare ? Object.fromEntries(compare.rows.map((r) => [r.id, r])) : {};
  const lines = [];
  lines.push(`detector: ${detector}`);
  lines.push(`weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', ')}  (beat window 70 ms, onset window 50 ms, tempo 4%)`);
  const head = `${'song'.padEnd(22)} ${'true'.padStart(8)} ${'est'.padStart(7)} ${'tempo'.padStart(6)} ${'beatF'.padStart(5)} ${'anyF'.padStart(5)} ${'level'.padStart(8)} ${'offMs'.padStart(6)} ${'onsF'.padStart(5)} ${'onsP'.padStart(5)} ${'onsR'.padStart(5)} ${'rawF'.padStart(5)} ${'downF'.padStart(5)} ${'ms/min'.padStart(7)} ${'score'.padStart(6)}${compare ? '  delta' : ''}`;
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const r of rows) {
    const s = r.s;
    const d = prev[r.id] ? s.score - prev[r.id].s.score : null;
    lines.push(`${r.id.padEnd(22)} ${String(r.truth.tempos.join('/')).padStart(8)} ${num(r.result.bpm).padStart(7)} ${s.tempo.flag.padStart(6)} ${pct(s.beats.f).padStart(5)} ${pct(s.beats.anyF).padStart(5)} ${s.beats.anyLevel.padStart(8)} ${num(s.beats.biasMs, 0).padStart(6)} ${pct(s.onsets.f).padStart(5)} ${pct(s.onsets.p).padStart(5)} ${pct(s.onsets.r).padStart(5)} ${pct(s.onsetsRaw && s.onsetsRaw.f).padStart(5)} ${pct(s.downbeats && s.downbeats.f).padStart(5)} ${num((r.ms / r.duration) * 60, 0).padStart(7)} ${pct(s.score).padStart(6)}${d == null ? '' : `  ${d >= 0 ? '+' : ''}${Math.round(d * 100)}`}`);
  }
  lines.push('-'.repeat(head.length));
  const m = summary;
  lines.push(`${'MEAN'.padEnd(22)} ${''.padStart(8)} ${''.padStart(7)} ${pct(m.tempoAcc1).padStart(6)} ${pct(m.beatF).padStart(5)} ${pct(m.beatAnyF).padStart(5)} ${''.padStart(8)} ${''.padStart(6)} ${pct(m.onsetF).padStart(5)} ${pct(m.onsetP).padStart(5)} ${pct(m.onsetR).padStart(5)} ${pct(m.onsetRawF).padStart(5)} ${pct(m.downbeatF).padStart(5)} ${num(m.msPerMinute, 0).padStart(7)} ${pct(m.overall).padStart(6)}${compare ? `  ${m.overall - compare.summary.overall >= 0 ? '+' : ''}${Math.round((m.overall - compare.summary.overall) * 100)}` : ''}`);
  lines.push(`tempo acc1 ${pct(m.tempoAcc1)}%  acc2 (octave ok) ${pct(m.tempoAcc2)}%  |  OVERALL SCORE ${(m.overall * 100).toFixed(1)} / 100`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const o = args(process.argv.slice(2));
  if (o.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (o.regen || !existsSync(o.dir) || !readdirSync(o.dir).some((f) => f.endsWith('.truth.json'))) generate({ out: o.dir });
  const res = await runBench(o);
  const cmp = o.compare && existsSync(o.compare) ? JSON.parse(readFileSync(o.compare, 'utf8')) : null;
  console.log(table(res, cmp));
  if (o.json) writeFileSync(o.json, JSON.stringify(res, null, 2));
}
