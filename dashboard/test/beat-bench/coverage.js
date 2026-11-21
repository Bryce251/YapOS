import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, pickAudio } from './audio.js';
import { merge, ONSET_WINDOW } from './score.js';
import { generate } from './generate.js';
import { generateHeldout, HELDOUT, HELDOUT2 } from './heldout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../web/js');
const WIN = ONSET_WINDOW * 1000;
const PICK_LINE = 'const base = pickOnsets(odf, bandOdf).filter((p) => p.full || grid[p.i]);';
const PICK_TAP = 'const allPicks = pickOnsets(odf, bandOdf); globalThis.__coverageTap = allPicks.map((p) => ({ t: p.i * (1000 / FPS), band: p.band, full: p.full, grid: Boolean(grid[p.i]) })); const base = allPicks.filter((p) => p.full || grid[p.i]);';
const DETAIL_LINE = 'const picks = [...base, ...detailPicks(odf, detailOdf(sp), base, raw)].sort((x, y) => x.i - y.i);';
const DETAIL_TAP = `${DETAIL_LINE} globalThis.__coverageTap.push(...picks.filter((p) => p.fine).map((p) => ({ t: p.i * (1000 / FPS), band: p.band, full: 0, grid: true })));`;
const INTERNALS = 'export { pickTimes, addSustains, assignLanes, planChords, planHolds, planRuns, allowed, fits, mixSeed };';

export const STAGES = Object.freeze([
  ['detect-peak', 'detection: no onset peak picked'],
  ['detect-grid', 'detection: peak dropped by beat-grid filter'],
  ['snap', 'quantize/snap (moved off or deduped per grid slot+band)'],
  ['merge', 'merge of near-simultaneous onsets into one grid candidate'],
  ['q-filter', 'grid-level filter (cfg.q / loud gate)'],
  ['spacing', 'min spacing between picks (cfg.space)'],
  ['density', 'section density target (cfg.nps)'],
  ['lanes', 'lane assignment (jack / lane busy / hold)'],
  ['run-cap', 'run length cap (RUN_MAX)'],
  ['legal', 'legalize lane rest / chord limits'],
  ['object-cap', 'OBJECT_CAPS'],
  ['nps-cap', 'NPS_CAPS'],
  ['ladder-trim', 'ladder trim (kept below the next level)'],
]);

const HELP = `usage: node test/beat-bench/coverage.js [options]
  --only <a,b>     only these song ids
  --seed <n>       chart seed (default 1, the editor default)
  --format <f>     mp3 | ogg | wav (default mp3 when ffmpeg exists, else wav)
  --json <file>    also write full results as JSON
  --songs          also print per-song Expert rows`;

function args(argv) {
  const o = { only: null, seed: 1, format: null, json: null, songs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--seed') o.seed = Number(argv[++i]) || 1;
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--json') o.json = resolve(argv[++i]);
    else if (a === '--songs') o.songs = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function absolutize(src, from) {
  return src.replace(/from '(\.[^']+)'/g, (m, p) => `from '${pathToFileURL(resolve(from, p)).href}'`);
}

export async function loadPipeline() {
  const dir = join(tmpdir(), 'yapos-beat-coverage');
  mkdirSync(dir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  let an = absolutize(readFileSync(join(WEB, 'beat-analyze.js'), 'utf8'), WEB);
  const tapped = an.includes(PICK_LINE) && an.includes(DETAIL_LINE);
  if (tapped) an = an.replace(PICK_LINE, PICK_TAP).replace(DETAIL_LINE, DETAIL_TAP);
  const anFile = join(dir, `beat-analyze-${stamp}.mjs`);
  writeFileSync(anFile, an);
  const chFile = join(dir, `song-chart-${stamp}.mjs`);
  writeFileSync(chFile, `${absolutize(readFileSync(join(WEB, 'song-chart.js'), 'utf8'), WEB)}\n${INTERNALS}\n`);
  const analyzer = await import(pathToFileURL(anFile).href);
  const chart = await import(pathToFileURL(chFile).href);
  const codec = await import(pathToFileURL(resolve(WEB, '../activity/js/games/beatcodec.js')).href);
  const shipped = await import(pathToFileURL(join(WEB, 'song-chart.js')).href);
  return { analyzer, chart, codec, shipped, tapped };
}

function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearest(arr, t) {
  const i = lowerBound(arr, t);
  let best = null;
  for (const k of [i - 1, i]) if (k >= 0 && k < arr.length && (best === null || Math.abs(arr[k] - t) < Math.abs(best - t))) best = arr[k];
  return best;
}

function near(arr, t, win = WIN) {
  const b = nearest(arr, t);
  return b !== null && Math.abs(b - t) <= win;
}

const sortNum = (a) => [...a].sort((x, y) => x - y);

function median(v) {
  if (!v.length) return null;
  const s = sortNum(v);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function preCap(notes, id, len, codec) {
  const { HOLD_DIFFS, HOLD_MIN_CS, HOLD_MAX_CS, END_PAD_MS, FIRST_NOTE_MS, LANES, MAX_CHORD, MAX_ACTIVE, LANE_REST_MS } = codec;
  const list = [...notes].sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  const free = [-Infinity, -Infinity, -Infinity, -Infinity];
  const holdsOk = HOLD_DIFFS.includes(id);
  for (const raw of list) {
    const n = { ...raw };
    if (n.e !== undefined) {
      const cs = Math.round((n.e - n.t) / 10);
      if (!holdsOk || cs < HOLD_MIN_CS) delete n.e;
      else n.e = n.t + Math.min(HOLD_MAX_CS, cs) * 10;
    }
    if (n.e !== undefined && n.e > len - END_PAD_MS) delete n.e;
    if (n.t < FIRST_NOTE_MS || n.t > len - END_PAD_MS) continue;
    if (n.l < 0 || n.l >= LANES || n.t < free[n.l]) continue;
    const same = out.filter((x) => x.t === n.t);
    if (same.length >= MAX_CHORD || same.some((x) => x.l === n.l)) continue;
    const active = out.filter((x) => x.e !== undefined && x.t < n.t && x.e >= n.t).length;
    if (active + same.length + 1 > MAX_ACTIVE) continue;
    if (n.e !== undefined && same.some((x) => x.e !== undefined)) delete n.e;
    out.push(n);
    free[n.l] = (n.e !== undefined ? n.e : n.t) + LANE_REST_MS;
  }
  return out;
}

function weakest(out, from, to) {
  let k = from;
  for (let i = from; i <= to; i++) if ((out[i].w || 0) < (out[k].w || 0)) k = i;
  return k;
}

function objectCapped(notes, id, codec) {
  const out = notes.slice();
  while (codec.objectCount(out) > codec.OBJECT_CAPS[id]) out.splice(weakest(out, 0, out.length - 1), 1);
  return out;
}

function npsCapped(notes, id, codec) {
  const out = notes.slice();
  const cap = codec.NPS_CAPS[id];
  for (let changed = true; changed;) {
    changed = false;
    let j = 0;
    for (let i = 0; i < out.length; i++) {
      while (out[i].t - out[j].t >= 1000) j += 1;
      if (i - j + 1 > cap) {
        out.splice(weakest(out, j, i), 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function sameNotes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].t !== b[i].t || a[i].l !== b[i].l || a[i].e !== b[i].e) return false;
  return true;
}

function capCeiling(times, cap) {
  const kept = [];
  let j = 0;
  for (const t of times) {
    while (j < kept.length && t - kept[j] >= 1000) j += 1;
    if (kept.length - j < cap) kept.push(t);
  }
  return kept.length;
}

function levelStages(P, ctx, i, step, finalNotes) {
  const { chart, codec } = P;
  const id = codec.DIFF_IDS[i];
  const cfg = chart.tunedConfig(id, step);
  const chosen = ctx.chosen.get(`${i}:${step}`);
  if (!chosen) throw new Error(`level ${id} step ${step} was not built`);
  const list = ctx.cands.filter((c) => chosen.has(c.gi));
  const plans = { chords: chart.planChords(list, cfg, ctx.analysis.marks), holds: chart.planHolds(list, ctx.analysis, cfg, ctx.end), runs: cfg.runs ? chart.planRuns(list) : new Map() };
  const rand = chart.seeded(chart.mixSeed(ctx.seed, i, step + 16, 2));
  const laned = chart.assignLanes(list, cfg, plans, rand).map((n) => ({ ...n, t: n.t - ctx.start, ...(n.e !== undefined ? { e: n.e - ctx.start } : {}) }));
  const legal = preCap(laned, id, ctx.len, codec);
  const objCap = objectCapped(legal, id, codec);
  const npsCap = npsCapped(objCap, id, codec);
  const built = ctx.built.get(`${i}:${step}`);
  if (built && !sameNotes(npsCap, built)) throw new Error(`stage replay for ${id} step ${step} does not match the product chart`);
  return { id, cfg, chosen, list, plans, laned, legal, objCap, npsCap, finalNotes };
}

function attribute(t, S, lv, P) {
  if (!near(S.picks, t)) return 'detect-peak';
  if (!near(S.hits, t)) return 'detect-grid';
  if (!near(S.snapped, t)) return 'snap';
  if (!near(S.cands, t)) return 'merge';
  if (!near(lv.chosenT, t)) {
    let c = null;
    for (const x of S.candObjs) {
      if (Math.abs(x.t - t) > WIN || lv.chosen.has(x.gi)) continue;
      if (!c || Math.abs(x.t - t) < Math.abs(c.t - t)) c = x;
    }
    if (!c) return 'density';
    if (!P.chart.allowed(c, lv.cfg)) return 'q-filter';
    if (!P.chart.fits(lv.chosenT, c.t, lv.cfg.space)) return 'spacing';
    return 'density';
  }
  if (!near(lv.lanedT, t)) {
    let c = null;
    for (const x of lv.list) if (Math.abs(x.t - t) <= WIN && (!c || Math.abs(x.t - t) < Math.abs(c.t - t))) c = x;
    return c && lv.plans.runs.get(c.gi) === -1 ? 'run-cap' : 'lanes';
  }
  if (!near(lv.legalT, t)) return 'legal';
  if (!near(lv.objT, t)) return 'object-cap';
  if (!near(lv.npsT, t)) return 'nps-cap';
  if (!near(lv.finalT, t)) return 'ladder-trim';
  return null;
}

function timesOf(notes) {
  return sortNum([...new Set(notes.map((n) => n.t))]);
}

function emptyAgg() {
  return { n: 0, hit: 0, bands: { L: [0, 0], M: [0, 0], H: [0, 0] }, notes: 0, fake: 0, fakeHard: 0, errs: [], signed: [], secs: 0, ceiling: 0, lost: Object.fromEntries(STAGES.map(([k]) => [k, 0])), bandLost: { L: {}, M: {}, H: {} }, lostInst: {}, steps: [] };
}

function addLevel(agg, r) {
  agg.n += r.n;
  agg.hit += r.hit;
  for (const b of 'LMH') {
    agg.bands[b][0] += r.bands[b][0];
    agg.bands[b][1] += r.bands[b][1];
  }
  agg.notes += r.notes;
  agg.fake += r.fake;
  agg.fakeHard += r.fakeHard;
  agg.errs.push(...r.errs);
  agg.signed.push(...r.signed);
  agg.secs += r.secs;
  agg.ceiling += r.ceiling;
  for (const k in r.lost) agg.lost[k] += r.lost[k];
  for (const k in r.lostInst) agg.lostInst[k] = (agg.lostInst[k] || 0) + r.lostInst[k];
  for (const b of 'LMH') for (const k in r.bandLost[b]) agg.bandLost[b][k] = (agg.bandLost[b][k] || 0) + r.bandLost[b][k];
  agg.steps.push(r.step);
}

export async function songCoverage(P, truth, pcm, sampleRate, { seed = 1 } = {}) {
  const { analyzer, chart, codec, shipped } = P;
  globalThis.__coverageTap = null;
  const analysis = analyzer.analyze(pcm, sampleRate);
  const tap = globalThis.__coverageTap || [];
  const dur = analysis.dur;
  const lo = codec.FIRST_NOTE_MS;
  const hi = dur - codec.END_PAD_MS;
  const inPlay = (o) => o.t * 1000 >= lo && o.t * 1000 <= hi;
  const hardAll = truth.onsets.filter((o) => !o.soft);
  const hard = merge(hardAll.filter(inPlay).map((o) => o.t)).map((t) => t * 1000);
  const anyTrue = sortNum(truth.onsets.map((o) => o.t * 1000));
  const hardTrue = sortNum(hardAll.map((o) => o.t * 1000));
  const byBand = {};
  for (const b of 'LMH') byBand[b] = merge(hardAll.filter((o) => o.band === b && inPlay(o)).map((o) => o.t)).map((t) => t * 1000);
  const instAt = (t) => [...new Set(hardAll.filter((o) => Math.abs(o.t * 1000 - t) <= 30).map((o) => `${o.band}:${o.inst || '?'}`))].join('+');
  const edge = merge(hardAll.map((o) => o.t)).length - merge(hardAll.filter(inPlay).map((o) => o.t)).length;
  const hits = analysis.hits || [];
  const S = {
    picks: sortNum((tap.length ? tap : hits.map((h) => ({ t: h.raw }))).map((p) => p.t)),
    hits: sortNum(hits.map((h) => h.raw)),
    snapped: sortNum((analysis.onsets || []).map((o) => o.t)),
    cands: null,
    candObjs: null,
  };
  const det = { n: 0, hit: 0, pickHit: 0, bands: {} };
  det.n = hard.length;
  det.hit = hard.filter((t) => near(S.hits, t)).length;
  det.pickHit = hard.filter((t) => near(S.picks, t)).length;
  for (const b of 'LMH') {
    const own = sortNum(hits.filter((h) => h.band === b).map((h) => h.raw));
    const inWin = own.filter((t) => t >= lo && t <= hi);
    det.bands[b] = {
      n: byBand[b].length,
      anyHit: byBand[b].filter((t) => near(S.hits, t)).length,
      sameHit: byBand[b].filter((t) => near(own, t)).length,
      est: inWin.length,
      estTrue: inWin.filter((t) => near(anyTrue, t)).length,
    };
  }
  const detInWin = S.hits.filter((t) => t >= lo && t <= hi);
  det.est = detInWin.length;
  det.estTrue = detInWin.filter((t) => near(anyTrue, t)).length;
  det.estHard = detInWin.filter((t) => near(hardTrue, t)).length;
  det.gridDropped = tap.filter((p) => !p.full && !p.grid).length;
  const modes = { auto: null, max: [codec.TUNE_MAX, codec.TUNE_MAX, codec.TUNE_MAX, codec.TUNE_MAX] };
  const out = { id: truth.id, dur, edge, det, levels: {} };
  for (const [mode, tune] of Object.entries(modes)) {
    const cache = {};
    const info = chart.makeChartsInfo(analysis, { start: 0, end: dur, seed, tune, cache });
    const ref = shipped.makeCharts(analysis, { start: 0, end: dur, seed, tune });
    if (JSON.stringify(ref.d) !== JSON.stringify(info.charts.d)) throw new Error(`instrumented charts differ from shipped charts for ${truth.id}`);
    const ctx = cache.ctx;
    S.candObjs = ctx.cands;
    S.cands = sortNum(ctx.cands.map((c) => c.t));
    out.levels[mode] = {};
    codec.DIFF_IDS.forEach((id, i) => {
      const finalNotes = codec.decodeNotes(info.charts.d[id]);
      const st = levelStages(P, ctx, i, info.used[i], finalNotes);
      const lv = {
        ...st,
        chosenT: sortNum(st.list.map((c) => c.t)),
        lanedT: timesOf(st.laned),
        legalT: timesOf(st.legal),
        objT: timesOf(st.objCap),
        npsT: timesOf(st.npsCap),
        finalT: timesOf(finalNotes),
      };
      const r = { step: info.used[i], n: hard.length, hit: 0, bands: {}, lostInst: {}, notes: lv.finalT.length, fake: 0, fakeHard: 0, errs: [], signed: [], secs: (hi - lo) / 1000, ceiling: capCeiling(hard, codec.NPS_CAPS[id]), lost: {}, bandLost: { L: {}, M: {}, H: {} } };
      for (const t of hard) {
        const nb = nearest(lv.finalT, t);
        if (nb !== null && Math.abs(nb - t) <= WIN) {
          r.hit += 1;
          r.errs.push(Math.abs(nb - t));
          r.signed.push(nb - t);
        } else {
          const why = attribute(t, S, lv, P) || 'ladder-trim';
          r.lost[why] = (r.lost[why] || 0) + 1;
          const key = `${why} ${instAt(t)}`;
          r.lostInst[key] = (r.lostInst[key] || 0) + 1;
        }
      }
      for (const b of 'LMH') {
        let h = 0;
        for (const t of byBand[b]) {
          if (near(lv.finalT, t)) h += 1;
          else {
            const why = attribute(t, S, lv, P) || 'ladder-trim';
            r.bandLost[b][why] = (r.bandLost[b][why] || 0) + 1;
          }
        }
        r.bands[b] = [h, byBand[b].length];
      }
      for (const t of lv.finalT) {
        if (!near(anyTrue, t)) r.fake += 1;
        if (!near(hardTrue, t)) r.fakeHard += 1;
      }
      out.levels[mode][id] = r;
    });
  }
  return out;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}` : '-').padStart(6);
const ms = (v) => (v == null ? '-' : v.toFixed(1)).padStart(6);

export function report(results, codec) {
  const L = [];
  const songs = results.length;
  L.push(`songs: ${songs}  window +-${WIN} ms  true onsets merged within 30 ms; onsets in the first ${codec.FIRST_NOTE_MS} ms / last ${codec.END_PAD_MS} ms excluded (${results.reduce((a, r) => a + r.edge, 0)} hard onsets)`);
  L.push('pooled over all songs (sum of hits / sum of onsets)');
  L.push('');
  L.push('DETECTOR (analysis.hits, before charting)');
  const d = { n: 0, hit: 0, pickHit: 0, est: 0, estTrue: 0, estHard: 0, grid: 0, b: { L: [0, 0, 0, 0, 0], M: [0, 0, 0, 0, 0], H: [0, 0, 0, 0, 0] } };
  for (const r of results) {
    d.n += r.det.n;
    d.hit += r.det.hit;
    d.pickHit += r.det.pickHit;
    d.est += r.det.est;
    d.estTrue += r.det.estTrue;
    d.estHard += r.det.estHard;
    d.grid += r.det.gridDropped;
    for (const b of 'LMH') {
      const x = r.det.bands[b];
      d.b[b][0] += x.n;
      d.b[b][1] += x.anyHit;
      d.b[b][2] += x.sameHit;
      d.b[b][3] += x.est;
      d.b[b][4] += x.estTrue;
    }
  }
  L.push(`${'band'.padEnd(6)} ${'true'.padStart(6)} ${'R(any)'.padStart(6)} ${'R(same)'.padStart(7)} ${'est'.padStart(6)} ${'P(any)'.padStart(6)}`);
  for (const b of 'LMH') L.push(`${b.padEnd(6)} ${String(d.b[b][0]).padStart(6)} ${pct(d.b[b][1], d.b[b][0])} ${pct(d.b[b][2], d.b[b][0]).padStart(7)} ${String(d.b[b][3]).padStart(6)} ${pct(d.b[b][4], d.b[b][3])}`);
  L.push(`${'all'.padEnd(6)} ${String(d.n).padStart(6)} ${pct(d.hit, d.n)} ${''.padStart(7)} ${String(d.est).padStart(6)} ${pct(d.estTrue, d.est)}   P(hard only) ${pct(d.estHard, d.est).trim()}  peaks before grid filter R ${pct(d.pickHit, d.n).trim()}  (${d.grid} peaks dropped by grid filter)`);
  L.push('R(any): a detected onset of any band within the window. R(same): the detected onset also has the same band. P(any): detected onsets with any true onset (hard or soft) nearby.');
  const aggs = {};
  for (const mode of ['auto', 'max']) {
    aggs[mode] = {};
    for (const id of codec.DIFF_IDS) {
      const a = emptyAgg();
      for (const r of results) addLevel(a, r.levels[mode][id]);
      aggs[mode][id] = a;
    }
  }
  for (const mode of ['auto', 'max']) {
    L.push('');
    L.push(`CHARTS at ${mode === 'auto' ? 'Auto' : 'max tuning (+3 on every level)'}`);
    L.push(`${'level'.padEnd(7)} ${'steps'.padStart(5)} ${'R hard'.padStart(6)} ${'R L'.padStart(6)} ${'R M'.padStart(6)} ${'R H'.padStart(6)} ${'notes/s'.padStart(7)} ${'P any'.padStart(6)} ${'fake'.padStart(5)} ${'P hard'.padStart(6)} ${'medErr'.padStart(6)} ${'bias'.padStart(6)} ${'npsCeil'.padStart(7)}`);
    for (const id of codec.DIFF_IDS) {
      const a = aggs[mode][id];
      const st = a.steps.reduce((x, y) => x + y, 0) / a.steps.length;
      L.push(`${id.padEnd(7)} ${st.toFixed(1).padStart(5)} ${pct(a.hit, a.n)} ${pct(...a.bands.L)} ${pct(...a.bands.M)} ${pct(...a.bands.H)} ${(a.notes / a.secs).toFixed(2).padStart(7)} ${pct(a.notes - a.fake, a.notes)} ${String(a.fake).padStart(5)} ${pct(a.notes - a.fakeHard, a.notes)} ${ms(median(a.errs))} ${ms(median(a.signed))} ${pct(a.ceiling, a.n).padStart(7)}`);
    }
    L.push('steps: mean internal tuning step used. npsCeil: share of true hard onsets that could be covered at all under the level NPS cap.');
    L.push('');
    L.push(`WHERE TRUE HARD ONSETS ARE LOST (${mode}), % of all true hard onsets`);
    L.push(`${'stage'.padEnd(12)} ${codec.DIFF_IDS.map((id) => id.padStart(7)).join(' ')}`);
    for (const [k] of STAGES) L.push(`${k.padEnd(12)} ${codec.DIFF_IDS.map((id) => pct(aggs[mode][id].lost[k], aggs[mode][id].n).padStart(7)).join(' ')}`);
    L.push(`${'covered'.padEnd(12)} ${codec.DIFF_IDS.map((id) => pct(aggs[mode][id].hit, aggs[mode][id].n).padStart(7)).join(' ')}`);
  }
  const top = aggs.max.expert;
  L.push('');
  L.push('EXPERT at max tuning, losses by band (% of that band)');
  L.push(`${'stage'.padEnd(12)} ${'L'.padStart(7)} ${'M'.padStart(7)} ${'H'.padStart(7)}`);
  for (const [k] of STAGES) L.push(`${k.padEnd(12)} ${'LMH'.split('').map((b) => pct(top.bandLost[b][k] || 0, top.bands[b][1]).padStart(7)).join(' ')}`);
  L.push('');
  L.push('TOP LOST INSTRUMENTS, Expert at max tuning (stage, true band:instrument at that time)');
  for (const [k, n] of Object.entries(top.lostInst).sort((a, b) => b[1] - a[1]).slice(0, 15)) L.push(`  ${k.padEnd(48)} ${String(n).padStart(5)}`);
  L.push('');
  L.push('RANKED LOSSES, Expert at max tuning');
  const ranked = STAGES.map(([k, label]) => [k, label, top.lost[k]]).filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2]);
  ranked.forEach(([k, label, n], i) => L.push(`${String(i + 1).padStart(2)}. ${label.padEnd(58)} ${String(n).padStart(5)} onsets ${pct(n, top.n)}%`));
  L.push('');
  L.push('stage key:');
  for (const [k, label] of STAGES) L.push(`  ${k.padEnd(12)} ${label}`);
  return { text: L.join('\n'), aggs, detector: d, ranked };
}

export function songTable(results) {
  const L = [];
  L.push(`${'song'.padEnd(22)} ${'hard'.padStart(5)} ${'detR'.padStart(6)} ${'autoR'.padStart(6)} ${'maxR'.padStart(6)} ${'maxP'.padStart(6)} ${'maxN/s'.padStart(6)} ${'top loss at max'.padStart(16)}`);
  for (const r of results) {
    const a = r.levels.auto.expert;
    const m = r.levels.max.expert;
    const worst = Object.entries(m.lost).sort((x, y) => y[1] - x[1])[0];
    L.push(`${r.id.padEnd(22)} ${String(m.n).padStart(5)} ${pct(r.det.hit, r.det.n)} ${pct(a.hit, a.n)} ${pct(m.hit, m.n)} ${pct(m.notes - m.fake, m.notes)} ${(m.notes / m.secs).toFixed(1).padStart(6)} ${worst ? `${worst[0]} ${worst[1]}`.padStart(16) : ''}`);
  }
  return L.join('\n');
}

function songSets() {
  return [
    { dir: join(HERE, 'out'), make: (out) => generate({ out }) },
    { dir: join(HERE, 'out-heldout'), make: (out) => generateHeldout({ out, set: HELDOUT }) },
    { dir: join(HERE, 'out-heldout2'), make: (out) => generateHeldout({ out, set: HELDOUT2 }) },
  ];
}

export async function runCoverage({ only = null, seed = 1, format = null, log = console.log } = {}) {
  const P = await loadPipeline();
  if (!P.tapped) log('note: the peak tap line was not found in beat-analyze.js, so detect-peak and detect-grid are merged');
  const results = [];
  for (const set of songSets()) {
    if (!existsSync(set.dir) || !readdirSync(set.dir).some((f) => f.endsWith('.truth.json'))) set.make(set.dir);
    const ids = readdirSync(set.dir).filter((f) => f.endsWith('.truth.json')).map((f) => f.slice(0, -'.truth.json'.length)).filter((id) => !only || only.includes(id)).sort();
    for (const id of ids) {
      const truth = JSON.parse(readFileSync(join(set.dir, `${id}.truth.json`), 'utf8'));
      const file = pickAudio(join(set.dir, id), format);
      if (!file) throw new Error(`no playable audio for ${id}`);
      const { pcm, sampleRate } = decode(file, truth.sampleRate);
      results.push(await songCoverage(P, truth, pcm, sampleRate, { seed }));
    }
  }
  return { results, codec: P.codec };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const o = args(process.argv.slice(2));
  if (o.help) {
    console.log(HELP);
    process.exit(0);
  }
  const { results, codec } = await runCoverage(o);
  const rep = report(results, codec);
  console.log(rep.text);
  if (o.songs) {
    console.log('');
    console.log(songTable(results));
  }
  if (o.json) writeFileSync(o.json, JSON.stringify({ results, summary: { detector: rep.detector, ranked: rep.ranked } }, null, 2));
}
