import { h, replace, nextId } from './dom.js';
import { button } from './ui.js';
import { analyze, mixDown, SR } from './beat-analyze.js';
import { halfTempo, doubleTempo, shiftGrid, shiftBar, tempoGrid, tapTempo, stripModel, TAP_MIN } from './beat-grid.js';
import { makeChartsInfo, chartStats, bestPart, snapToDownbeat, readSteps, tuneNote, SECTION_CHOICES, FULL_SECTION, BEST_PART_MS } from './song-chart.js';
import { decodeNotes, DIFF_IDS, DIFF_NAMES, OFFSET_MIN, OFFSET_MAX, SECTION_MIN_MS, SECTION_MAX_MS, BPM_MIN, BPM_MAX, TUNE_MIN, TUNE_MAX, ChartError } from '../activity/js/games/beatcodec.js';
import { formatLength } from './song-upload.js';

export const NO_PLAY = 'This file would not play in your browser. Try an MP3.';
export const NO_BEAT = 'No steady beat was found in this song. Try another song.';
export const OFFSET_STEPS = Object.freeze([-10, -1, 1, 10]);
export const TAP_KEYS = Object.freeze({ d: 0, f: 1, j: 2, k: 3 });
export const TAP_WINDOW_MS = 150;
export const LANE_COLORS = Object.freeze(['#f472b6', '#facc15', '#5eead4', '#a78bfa']);
export const KIND_COLORS = Object.freeze({ kick: '#f472b6', snare: '#facc15', hat: '#5eead4', tonal: '#a78bfa' });
export const PREVIEW_COLOR = '#34d399';
export const LOOK_MS = 1600;
export const STRIP_MS = 8000;
export const SHIFT_STEP = 0.25;

export function clampOffset(v) {
  const n = Math.round(Number(v) || 0);
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, n));
}

export async function decodeSong(buf, win = globalThis) {
  const Ctx = win.OfflineAudioContext || win.webkitOfflineAudioContext;
  if (typeof Ctx !== 'function') throw new Error(NO_PLAY);
  let audio;
  try {
    audio = await new Ctx(2, 1, SR).decodeAudioData(buf.slice(0));
  } catch {
    throw new Error(NO_PLAY);
  }
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  return { pcm: mixDown(chans), sr: audio.sampleRate, duration_ms: Math.round(audio.duration * 1000) };
}

export function analyzeSong(pcm, sr, { onProgress = () => {}, win = globalThis, hint = 0 } = {}) {
  if (typeof win.Worker !== 'function') return Promise.resolve(analyze(pcm, sr, { onProgress, hint }));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new win.Worker(new URL('./beat-analyze-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(analyze(pcm, sr, { onProgress, hint }));
      return;
    }
    worker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'progress') onProgress(d.p);
      else if (d.type === 'done') {
        worker.terminate();
        resolve(d.analysis);
      } else if (d.type === 'error') {
        worker.terminate();
        reject(new Error(d.message || NO_PLAY));
      }
    });
    worker.addEventListener('error', () => {
      worker.terminate();
      reject(new Error(NO_PLAY));
    });
    worker.postMessage({ id: 1, pcm, sr, hint }, [pcm.buffer]);
  });
}

export const LENGTH_CHOICES = Object.freeze([...SECTION_CHOICES, FULL_SECTION]);
export const PREVIEW_TAIL_MS = 1000;

export function defaultLength(durationMs) {
  return Math.max(SECTION_MIN_MS, Math.min(SECTION_MAX_MS, durationMs));
}

export function lengthText(ms) {
  return ms === FULL_SECTION ? 'Full song' : `${ms / 1000} s`;
}

export function beatSummary(a) {
  if (!a || !a.bpm) return 'No beat found yet.';
  const shuffled = Array.isArray(a.feel) && (a.feel[0] !== 0.5 || a.feel[1] !== 0.5);
  const feel = a.swing ? 'swung' : shuffled ? 'light swing' : 'straight';
  const changed = a.detected && a.detected.bpm && Math.abs(a.bpm - a.detected.bpm) / a.detected.bpm > 0.02 ? ` (found ${Math.round(a.detected.bpm * 10) / 10})` : '';
  return `Tempo ${Math.round(a.bpm * 10) / 10} BPM${changed}, ${a.meter} beats a bar, ${feel} feel.`;
}

export function stepText(step) {
  if (!step) return 'Auto';
  const n = Math.abs(step);
  return `${n} step${n === 1 ? '' : 's'} ${step > 0 ? 'harder' : 'easier'}`;
}

export function edgeText(name, step, room, ready = true) {
  if (!ready) return '';
  if (!room.harder && step < TUNE_MAX) return `${name} is as hard as this part of the song allows.`;
  if (!room.easier && step > TUNE_MIN) return `${name} is as easy as this part of the song allows.`;
  return '';
}

export function statText(name, s, bpm) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${name}: ${plural(s.objects, 'note')}, ${s.avg} a second on average, up to ${s.peak} a second, ${plural(s.chords, 'chord')}, ${plural(s.holds, 'hold')}. Tempo ${bpm} BPM.`;
}

function nowOf(win) {
  return win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now();
}

export function createSongEditor({ analysis, buf, initial = {}, win = globalThis, onChange = () => {}, redetect = null, now = () => nowOf(win) }) {
  let a = analysis;
  const dur = a.dur;
  const fullLen = defaultLength(dur);
  const full = initial.end_ms === undefined || ((initial.start_ms || 0) === 0 && initial.end_ms >= fullLen);
  const st = {
    full,
    len: full ? fullLen : initial.end_ms - initial.start_ms,
    start: full ? 0 : initial.start_ms || 0,
    preview: Number.isInteger(initial.preview_ms) ? initial.preview_ms : initial.start_ms || 0,
    offset: clampOffset(initial.offset_ms || 0),
    seed: Number(initial.seed) || 1,
    diff: 'normal',
    tune: readSteps(initial.tune),
    info: null,
    charts: null,
    error: '',
    playing: false,
    tap: false,
    hits: 0,
    taps: [],
    view: initial.start_ms || 0,
    busy: false,
    songT: -1,
  };
  let audio = null;
  let decoded = null;
  let source = null;
  let raf = 0;
  let t0 = 0;
  const hit = new Set();
  const cache = {};

  const status = h('p', { class: 'song-editor-status muted', attrs: { 'aria-live': 'polite' } });
  const lenRow = h('div', { class: 'segmented song-chips', attrs: { role: 'group', 'aria-label': 'How long the song plays' } });
  const startId = nextId('song-start');
  const startInput = h('input', { type: 'range', id: startId, class: 'song-range', min: 0, max: startMax(), step: 100, value: st.full ? st.preview : st.start });
  const startLabel = h('label', { class: 'field-label', htmlFor: startId, text: 'Start' });
  const startText = h('span', { class: 'song-start-text' });
  const offsetText = h('span', { class: 'song-offset-text', attrs: { 'aria-live': 'polite' } });
  const tabs = h('div', { class: 'segmented song-tabs', attrs: { role: 'group', 'aria-label': 'Difficulty' } });
  const statLine = h('p', { class: 'song-stat muted', attrs: { 'aria-live': 'polite' } });
  const stepLabel = h('span', { class: 'song-step-text', attrs: { 'aria-live': 'polite' } });
  const tuneText = h('p', { class: 'song-tune-note', attrs: { 'aria-live': 'polite' } });
  const easierBtn = button({ label: 'Easier', icon: 'minus', size: 'sm', ariaLabel: 'Make this level easier', onClick: () => retune(-1) });
  const harderBtn = button({ label: 'Harder', icon: 'plus', size: 'sm', ariaLabel: 'Make this level harder', onClick: () => retune(1) });
  const resetBtn = button({ label: 'Reset to auto', size: 'sm', ariaLabel: 'Reset this level to the automatic notes', onClick: () => retune(0, true) });
  const canvas = h('canvas', { class: 'song-canvas', width: 320, height: 360, attrs: { 'aria-label': 'Note preview' } });
  const strip = h('canvas', { class: 'song-strip', width: 960, height: 144, attrs: { role: 'img', 'aria-label': 'Beat map: the waveform with the beats, bar starts and hits YapOS found' } });
  const beatText = h('p', { class: 'song-beat-text', attrs: { 'aria-live': 'polite' } });
  const viewText = h('span', { class: 'song-start-text' });
  const tapText = h('p', { class: 'song-tap-text muted', attrs: { 'aria-live': 'polite' } });
  const playBtn = button({ label: 'Play', icon: 'play', size: 'sm', onClick: () => (st.playing ? stop() : play()) });
  const tapBtn = button({ label: 'Tap test', size: 'sm', onClick: () => toggleTap() });
  const bestBtn = button({ label: 'Find the best part', size: 'sm', onClick: () => {
    stop();
    if (st.full) {
      setPreview(bestPart(a, BEST_PART_MS));
      return;
    }
    st.start = bestPart(a, st.len);
    st.view = st.start;
    remake();
  } });

  function startMax() {
    return Math.max(0, dur - (st.full ? SECTION_CHOICES[0] : st.len));
  }

  function setPreview(ms) {
    st.preview = Math.max(0, Math.min(Math.round(Number(ms) || 0), Math.max(0, st.start + st.len - PREVIEW_TAIL_MS)));
    st.view = Math.max(0, st.preview - STRIP_MS * 0.2);
    draw();
    onChange(value());
  }

  function pickLength(ms) {
    stop();
    if (ms === FULL_SECTION) {
      if (!st.full) st.preview = st.start;
      st.full = true;
      st.start = 0;
      st.len = fullLen;
    } else {
      if (st.full) st.start = st.preview;
      st.full = false;
      st.len = ms;
    }
    remake();
  }
  const regenBtn = button({ label: 'Make new notes', size: 'sm', onClick: () => {
    stop();
    st.seed += 1;
    remake();
  } });
  const halfBtn = button({ label: 'Half', size: 'sm', ariaLabel: 'Half the tempo', onClick: () => edit(halfTempo(a), 'Tempo halved.') });
  const doubleBtn = button({ label: 'Double', size: 'sm', ariaLabel: 'Double the tempo', onClick: () => edit(doubleTempo(a), 'Tempo doubled.') });
  const tempoTapBtn = button({ label: 'Tap tempo', size: 'sm', className: 'song-tap-btn', ariaLabel: 'Tap tempo: click along with the beat', onClick: () => tapTempoClick() });
  const earlierBtn = button({ label: 'Grid earlier', size: 'sm', ariaLabel: 'Move the beat grid a quarter beat earlier', onClick: () => edit(shiftGrid(a, -SHIFT_STEP), 'Grid moved a quarter beat earlier.') });
  const laterBtn = button({ label: 'Grid later', size: 'sm', ariaLabel: 'Move the beat grid a quarter beat later', onClick: () => edit(shiftGrid(a, SHIFT_STEP), 'Grid moved a quarter beat later.') });
  const barBtn = button({ label: 'Move bar start', size: 'sm', ariaLabel: 'Move the bar start one beat later', onClick: () => edit(shiftBar(a, 1), 'Bar start moved one beat.') });
  const redetectBtn = button({ label: 'Re-detect', icon: 'refresh', size: 'sm', onClick: () => runRedetect() });
  const backBtn = button({ label: 'Back', icon: 'chevron-left', size: 'sm', ariaLabel: 'Show an earlier part of the beat map', onClick: () => moveView(-STRIP_MS / 2) });
  const nextBtn = button({ label: 'Next', iconRight: 'chevron-right', size: 'sm', ariaLabel: 'Show a later part of the beat map', onClick: () => moveView(STRIP_MS / 2) });
  const editBtns = [halfBtn, doubleBtn, tempoTapBtn, earlierBtn, laterBtn, barBtn, redetectBtn];

  function moveView(ms) {
    st.view = Math.max(0, Math.min(Math.max(0, dur - STRIP_MS), st.view + ms));
    drawStrip();
  }

  function edit(next, message = '') {
    if (st.busy || !next || next === a) return;
    stop();
    if (!next.bpm || next.bpm < BPM_MIN / 2 || next.bpm > BPM_MAX * 2) {
      status.textContent = 'That tempo is out of range.';
      return;
    }
    a = next;
    remake();
    if (message && !st.error) status.textContent = message;
  }

  function tapTempoClick() {
    const t = now();
    if (st.taps.length && t - st.taps[st.taps.length - 1] > 2000) st.taps = [];
    st.taps.push(t);
    const { bpm, count } = tapTempo(st.taps);
    tempoTapBtn.setAttribute('aria-pressed', 'true');
    if (!bpm) {
      beatText.textContent = `Keep tapping with the beat: ${TAP_MIN - count} more.`;
      return;
    }
    if (bpm < BPM_MIN / 2 || bpm > BPM_MAX * 2) {
      beatText.textContent = 'That tap tempo is out of range. Tap again.';
      st.taps = [];
      return;
    }
    edit(tempoGrid(a, bpm), `Tempo set to ${bpm} BPM from your taps. Press Re-detect to follow the song closely at this tempo.`);
  }

  async function runRedetect() {
    if (st.busy) return;
    stop();
    st.busy = true;
    for (const b of editBtns) b.disabled = true;
    const hint = a.detected && a.detected.bpm && a.bpm && Math.abs(a.bpm - a.detected.bpm) / a.detected.bpm > 0.02 ? a.bpm : 0;
    status.textContent = hint ? `Finding the beat again near ${Math.round(hint * 10) / 10} BPM...` : 'Finding the beat again...';
    try {
      const run = redetect || (async (want, onProgress) => {
        const d = await decodeSong(buf, win);
        return analyzeSong(d.pcm, d.sr, { win, hint: want, onProgress });
      });
      const next = await run(hint, () => {});
      st.busy = false;
      if (!next || !next.bpm) throw new Error(NO_BEAT);
      st.taps = [];
      tempoTapBtn.setAttribute('aria-pressed', 'false');
      a = next;
      remake();
      if (!st.error) status.textContent = `Found ${Math.round(a.bpm * 10) / 10} BPM.`;
    } catch (err) {
      st.busy = false;
      status.textContent = err && err.message ? err.message : NO_PLAY;
    } finally {
      for (const b of editBtns) b.disabled = false;
    }
  }

  function remake() {
    if (st.full) {
      st.start = 0;
      st.len = fullLen;
      st.preview = Math.max(0, Math.min(st.preview, Math.max(0, st.len - PREVIEW_TAIL_MS)));
    } else {
      st.start = Math.max(0, Math.min(st.start, dur - st.len));
      st.preview = st.start;
    }
    const end = st.start + st.len;
    try {
      st.info = makeChartsInfo(a, { start: st.start, end, seed: st.seed, tune: st.tune, cache });
      st.charts = st.info.charts;
      st.error = '';
    } catch (err) {
      st.info = null;
      st.charts = null;
      st.error = err instanceof ChartError ? `${err.message} Try another part of the song.` : 'Notes could not be made for this part. Try another part of the song.';
    }
    draw();
    onChange(value());
  }

  function retune(delta, reset = false) {
    const i = DIFF_IDS.indexOf(st.diff);
    const next = reset ? 0 : Math.min(TUNE_MAX, Math.max(TUNE_MIN, st.tune[i] + delta));
    if (next === st.tune[i]) return;
    stop();
    st.tune = st.tune.map((x, k) => (k === i ? next : x));
    remake();
  }

  function pickDiff(id) {
    if (!DIFF_IDS.includes(id) || id === st.diff) return;
    stop();
    st.diff = id;
    draw();
  }

  function draw() {
    replace(lenRow, ...LENGTH_CHOICES.map((ms) => {
      const on = ms === FULL_SECTION ? st.full : !st.full && st.len === ms;
      return h('button', {
        type: 'button',
        class: ['btn', 'btn-sm', on ? 'btn-segment-active' : 'btn-segment'],
        disabled: ms > dur,
        attrs: { 'aria-pressed': on ? 'true' : 'false' },
        text: lengthText(ms),
        on: { click: () => pickLength(ms) },
      });
    }));
    startInput.max = String(startMax());
    startInput.value = String(st.full ? st.preview : st.start);
    startLabel.textContent = st.full ? 'Best part' : 'Start';
    startText.textContent = st.full
      ? `Plays the whole song (${formatLength(st.len)}). Shorter games start at ${formatLength(st.preview)}.`
      : `Plays ${formatLength(st.start)} to ${formatLength(st.start + st.len)} of ${formatLength(dur)}`;
    offsetText.textContent = `Offset: ${st.offset} ms`;
    beatText.textContent = beatSummary(a);
    const stats = st.charts ? chartStats(st.charts) : null;
    replace(tabs, ...DIFF_IDS.map((id) => h('button', {
      type: 'button',
      class: ['btn', 'btn-sm', st.diff === id ? 'btn-segment-active' : 'btn-segment'],
      attrs: { 'aria-pressed': st.diff === id ? 'true' : 'false' },
      text: stats ? `${DIFF_NAMES[id]} ${stats[id].objects}` : DIFF_NAMES[id],
      on: { click: () => pickDiff(id) },
    })));
    statLine.textContent = stats ? statText(DIFF_NAMES[st.diff], stats[st.diff], st.charts.bpm) : '';
    const step = st.tune[DIFF_IDS.indexOf(st.diff)];
    stepLabel.textContent = `${DIFF_NAMES[st.diff]}: ${stepText(step)}`;
    const room = st.info && st.info.room ? st.info.room[DIFF_IDS.indexOf(st.diff)] : { easier: true, harder: true };
    easierBtn.disabled = step <= TUNE_MIN || !st.charts || !room.easier;
    harderBtn.disabled = step >= TUNE_MAX || !st.charts || !room.harder;
    resetBtn.disabled = step === 0 || !st.charts;
    tuneText.textContent = [tuneNote(st.info), edgeText(DIFF_NAMES[st.diff], step, room, Boolean(st.charts))].filter(Boolean).join(' ');
    status.textContent = st.error;
    status.classList.toggle('is-error', Boolean(st.error));
    playBtn.disabled = !st.charts;
    paintIdle();
    drawStrip();
  }

  function stripView() {
    const from = Math.max(0, Math.min(st.view, Math.max(0, dur - STRIP_MS)));
    return { from, to: Math.min(dur, from + STRIP_MS) };
  }

  function drawStrip() {
    const { from, to } = stripView();
    viewText.textContent = `Showing ${formatLength(from)} to ${formatLength(to)}`;
    backBtn.disabled = from <= 0;
    nextBtn.disabled = to >= dur;
    const g = strip.getContext ? strip.getContext('2d') : null;
    if (!g) return;
    const W = strip.width;
    const H = strip.height;
    const m = stripModel(a, from, to);
    g.fillStyle = '#0c0a14';
    g.fillRect(0, 0, W, H);
    const s0 = (st.start - from) / (to - from);
    const s1 = (st.start + st.len - from) / (to - from);
    if (s1 > 0 && s0 < 1) {
      g.fillStyle = '#1b1530';
      g.fillRect(Math.max(0, s0) * W, 0, (Math.min(1, s1) - Math.max(0, s0)) * W, H);
    }
    const mid = H * 0.55;
    g.fillStyle = '#4b5563';
    const bw = Math.max(1, W / Math.max(1, m.env.length));
    for (const e of m.env) {
      const hgt = Math.max(1, e.v * mid * 0.9);
      g.fillRect(e.x * W, mid - hgt / 2, bw, hgt);
    }
    for (const b of m.beats) {
      g.fillStyle = b.down ? '#ffffff' : 'rgba(255,255,255,0.35)';
      g.fillRect(b.x * W - (b.down ? 1.5 : 0.5), 0, b.down ? 3 : 1, H);
    }
    for (const o of m.onsets) {
      g.fillStyle = KIND_COLORS[o.kind] || '#ffffff';
      const r = 2 + 3 * Math.min(1, o.s || 0);
      const row = { kick: 0.82, snare: 0.88, hat: 0.94, tonal: 0.76 }[o.kind] || 0.9;
      g.fillRect(o.x * W - r, H * row - r, r * 2, r * 2);
    }
    if (st.full) {
      const px = (st.preview - from) / (to - from);
      if (px >= 0 && px <= 1) {
        g.fillStyle = PREVIEW_COLOR;
        g.fillRect(px * W - 1.5, 0, 3, H);
        g.fillRect(px * W - 1.5, 0, 12, 8);
      }
    }
    if (st.songT >= 0) {
      const x = (st.start + st.offset + st.songT - from) / (to - from);
      if (x >= 0 && x <= 1) {
        g.fillStyle = '#f87171';
        g.fillRect(x * W - 1, 0, 2, H);
      }
    }
  }

  function notesNow() {
    return st.charts ? decodeNotes(st.charts.d[st.diff]) : [];
  }

  function paintIdle() {
    const first = notesNow()[0];
    paint(first ? Math.max(0, first.t - LOOK_MS * 0.6) : 0);
  }

  function paint(songT) {
    const g = canvas.getContext ? canvas.getContext('2d') : null;
    if (!g) return;
    const W = canvas.width;
    const H = canvas.height;
    const lw = W / 4;
    const hitY = H * 0.85;
    g.fillStyle = '#0c0a14';
    g.fillRect(0, 0, W, H);
    for (let l = 0; l < 4; l++) {
      g.fillStyle = l % 2 ? '#15121f' : '#120f1b';
      g.fillRect(l * lw, 0, lw, H);
    }
    g.fillStyle = '#ffffff';
    g.fillRect(0, hitY, W, 2);
    const y = (t) => hitY - ((t - songT) / LOOK_MS) * hitY;
    for (const n of notesNow()) {
      const end = n.e !== undefined ? n.e : n.t;
      if (end < songT - 200 || n.t > songT + LOOK_MS) continue;
      g.fillStyle = LANE_COLORS[n.l];
      if (n.e !== undefined) {
        g.globalAlpha = 0.55;
        g.fillRect(n.l * lw + lw * 0.33, y(n.e), lw * 0.34, Math.max(2, y(n.t) - y(n.e)));
        g.globalAlpha = 1;
      }
      if (hit.has(`${n.t}:${n.l}`)) g.globalAlpha = 0.25;
      g.fillRect(n.l * lw + 6, y(n.t) - 7, lw - 12, 14);
      g.globalAlpha = 1;
    }
  }

  async function ensureAudio() {
    if (!audio) {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (typeof Ctx !== 'function') throw new Error(NO_PLAY);
      audio = new Ctx();
    }
    if (!decoded) decoded = await audio.decodeAudioData(buf.slice(0));
    if (audio.state === 'suspended') await audio.resume();
  }

  async function play() {
    if (!st.charts) return;
    try {
      await ensureAudio();
    } catch {
      st.error = NO_PLAY;
      draw();
      return;
    }
    hit.clear();
    st.hits = 0;
    source = audio.createBufferSource();
    source.buffer = decoded;
    source.connect(audio.destination);
    const from = Math.max(0, (st.start + st.offset) / 1000);
    t0 = audio.currentTime + 0.05;
    source.start(t0, from, st.len / 1000);
    source.addEventListener('ended', () => {
      if (st.playing) stop();
    });
    st.playing = true;
    playBtn.querySelector('.btn-label').textContent = 'Pause';
    const loop = () => {
      if (!st.playing) return;
      const songT = (audio.currentTime - t0) * 1000;
      paint(songT);
      st.songT = songT;
      const at = st.start + songT;
      const { from, to } = stripView();
      if (at > to - STRIP_MS * 0.1 || at < from) st.view = Math.max(0, at - STRIP_MS * 0.2);
      drawStrip();
      raf = win.requestAnimationFrame(loop);
    };
    raf = win.requestAnimationFrame(loop);
  }

  function stop() {
    st.playing = false;
    st.songT = -1;
    if (raf && win.cancelAnimationFrame) win.cancelAnimationFrame(raf);
    raf = 0;
    if (source) {
      try { source.stop(); } catch {}
      source = null;
    }
    const label = playBtn.querySelector('.btn-label');
    if (label) label.textContent = 'Play';
    paintIdle();
  }

  function tapAt(lane, songT) {
    let best = null;
    for (const n of notesNow()) {
      if (n.l !== lane || hit.has(`${n.t}:${n.l}`)) continue;
      const d = Math.abs(n.t - songT);
      if (d <= TAP_WINDOW_MS && (!best || d < Math.abs(best.t - songT))) best = n;
    }
    if (!best) return false;
    hit.add(`${best.t}:${best.l}`);
    st.hits += 1;
    tapText.textContent = `Tap test: ${st.hits} of ${notesNow().length} hit. Keys D, F, J and K.`;
    return true;
  }

  function onKey(e) {
    if (!st.tap || !st.playing || e.repeat) return;
    const lane = TAP_KEYS[String(e.key || '').toLowerCase()];
    if (lane === undefined) return;
    e.preventDefault();
    tapAt(lane, (audio.currentTime - t0) * 1000);
  }

  function toggleTap() {
    st.tap = !st.tap;
    tapBtn.setAttribute('aria-pressed', st.tap ? 'true' : 'false');
    tapText.textContent = st.tap ? 'Tap test is on. Press Play and hit D, F, J and K with the notes.' : '';
  }

  startInput.addEventListener('change', () => {
    stop();
    if (st.full) {
      setPreview(snapToDownbeat(a, Number(startInput.value) || 0));
      return;
    }
    st.start = snapToDownbeat(a, Number(startInput.value) || 0);
    st.view = st.start;
    remake();
  });
  if (win.document && typeof win.document.addEventListener === 'function') win.document.addEventListener('keydown', onKey);
  tapBtn.setAttribute('aria-pressed', 'false');
  tempoTapBtn.setAttribute('aria-pressed', 'false');

  const nudges = OFFSET_STEPS.map((step) => button({ label: `${step > 0 ? '+' : ''}${step}`, size: 'sm', ariaLabel: `Move the notes ${Math.abs(step)} ms ${step > 0 ? 'later' : 'earlier'}`, onClick: () => {
    st.offset = clampOffset(st.offset + step);
    draw();
    onChange(value());
  } }));

  const el = h('div', { class: 'song-editor' },
    h('div', { class: 'song-beat' },
      h('p', { class: 'field-label', text: 'Beat map' }),
      strip,
      h('div', { class: 'song-row' }, backBtn, nextBtn, viewText),
      h('p', { class: 'field-help', text: 'Thick lines are bar starts and thin lines are beats. Dots are the hits YapOS heard: pink kicks, yellow snares, teal hi-hats and purple notes.' }),
      beatText,
      h('div', { class: 'song-row', attrs: { role: 'group', 'aria-label': 'Tempo' } }, halfBtn, doubleBtn, tempoTapBtn, redetectBtn),
      h('div', { class: 'song-row', attrs: { role: 'group', 'aria-label': 'Shift the grid' } }, earlierBtn, laterBtn, barBtn),
      h('p', { class: 'field-help', text: 'If the lines sit between the hits, move the grid. If the tempo is twice or half as fast as the song, use Half or Double, or tap along with Tap tempo.' })),
    h('div', { class: 'song-editor-grid' },
      h('div', { class: 'song-editor-side' },
        h('p', { class: 'field-label', text: 'Length' }), lenRow,
        startLabel, startInput, startText,
        h('div', { class: 'song-row' }, bestBtn, regenBtn),
        h('p', { class: 'field-label', text: 'Timing' }),
        h('div', { class: 'song-row' }, ...nudges, offsetText),
        h('p', { class: 'field-help', text: 'If the notes feel early, move them later. If they feel late, move them earlier.' }),
        h('p', { class: 'field-label', text: 'Difficulty tuning' }), tabs,
        h('div', { class: 'song-row song-tune', attrs: { role: 'group', 'aria-label': 'How hard this level is' } }, easierBtn, stepLabel, harderBtn, resetBtn),
        statLine, tuneText,
        h('p', { class: 'field-help', text: 'Pick a level, then press Harder or Easier if it does not feel right for this song. Only that level is remade, and the preview plays it. Each level always stays clearly harder than the one below.' }),
        status),
      h('div', { class: 'song-editor-preview' }, canvas, h('div', { class: 'song-row' }, playBtn, tapBtn), tapText)));

  function value() {
    if (!st.charts) return null;
    return { start_ms: st.start, end_ms: st.start + st.len, offset_ms: st.offset, preview_ms: st.full ? st.preview : st.start, charts: st.charts };
  }

  function destroy() {
    stop();
    if (win.document && typeof win.document.removeEventListener === 'function') win.document.removeEventListener('keydown', onKey);
    if (audio && typeof audio.close === 'function') audio.close().catch(() => {});
    audio = null;
    decoded = null;
  }

  remake();
  return {
    el,
    value,
    destroy,
    state: st,
    tapAt,
    strip,
    get analysis() { return a; },
    nudge: (step) => nudges[OFFSET_STEPS.indexOf(step)].click(),
    chips: () => [...lenRow.querySelectorAll('button')],
    tabs: () => [...tabs.querySelectorAll('button')],
    pickDiff,
    tuning: { easier: easierBtn, harder: harderBtn, reset: resetBtn, step: stepLabel, note: tuneText, stats: statLine },
    controls: { half: halfBtn, double: doubleBtn, tap: tempoTapBtn, earlier: earlierBtn, later: laterBtn, bar: barBtn, redetect: redetectBtn, back: backBtn, next: nextBtn },
    redraw: drawStrip,
  };
}
