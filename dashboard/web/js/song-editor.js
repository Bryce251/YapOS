import { h, replace, nextId } from './dom.js';
import { button } from './ui.js';
import { analyze, mixDown, SR } from './beat-analyze.js';
import { makeCharts, chartStats, bestPart, snapToDownbeat, SECTION_CHOICES } from './song-chart.js';
import { decodeNotes, DIFF_IDS, DIFF_NAMES, OFFSET_MIN, OFFSET_MAX, SECTION_MIN_MS, SECTION_MAX_MS, ChartError } from '../activity/js/games/beatcodec.js';
import { formatLength } from './song-upload.js';

export const NO_PLAY = 'This file would not play in your browser. Try an MP3.';
export const OFFSET_STEPS = Object.freeze([-10, -1, 1, 10]);
export const TAP_KEYS = Object.freeze({ d: 0, f: 1, j: 2, k: 3 });
export const TAP_WINDOW_MS = 150;
export const LANE_COLORS = Object.freeze(['#f472b6', '#facc15', '#5eead4', '#a78bfa']);
export const LOOK_MS = 1600;

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

export function analyzeSong(pcm, sr, { onProgress = () => {}, win = globalThis } = {}) {
  if (typeof win.Worker !== 'function') return Promise.resolve(analyze(pcm, sr, { onProgress }));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new win.Worker(new URL('./beat-analyze-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(analyze(pcm, sr, { onProgress }));
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
    worker.postMessage({ id: 1, pcm, sr }, [pcm.buffer]);
  });
}

export function defaultLength(durationMs) {
  const fit = SECTION_CHOICES.filter((x) => x <= durationMs);
  if (fit.includes(60000)) return 60000;
  if (fit.length) return fit[fit.length - 1];
  return Math.max(SECTION_MIN_MS, Math.min(SECTION_MAX_MS, durationMs));
}

export function createSongEditor({ analysis, buf, initial = {}, win = globalThis, onChange = () => {} }) {
  const dur = analysis.dur;
  const st = {
    len: initial.end_ms !== undefined ? initial.end_ms - initial.start_ms : defaultLength(dur),
    start: initial.start_ms || 0,
    offset: clampOffset(initial.offset_ms || 0),
    seed: Number(initial.seed) || 1,
    diff: 'normal',
    charts: null,
    error: '',
    playing: false,
    tap: false,
    hits: 0,
  };
  let audio = null;
  let decoded = null;
  let source = null;
  let raf = 0;
  let t0 = 0;
  const hit = new Set();

  const status = h('p', { class: 'song-editor-status muted', attrs: { 'aria-live': 'polite' } });
  const lenRow = h('div', { class: 'segmented song-chips', attrs: { role: 'group', 'aria-label': 'How long the song plays' } });
  const startId = nextId('song-start');
  const startInput = h('input', { type: 'range', id: startId, class: 'song-range', min: 0, max: Math.max(0, dur - st.len), step: 100, value: st.start });
  const startText = h('span', { class: 'song-start-text' });
  const offsetText = h('span', { class: 'song-offset-text', attrs: { 'aria-live': 'polite' } });
  const tabs = h('div', { class: 'segmented song-tabs', attrs: { role: 'group', 'aria-label': 'Difficulty' } });
  const statLine = h('p', { class: 'song-stat muted' });
  const canvas = h('canvas', { class: 'song-canvas', width: 320, height: 360, attrs: { 'aria-label': 'Note preview' } });
  const tapText = h('p', { class: 'song-tap-text muted', attrs: { 'aria-live': 'polite' } });
  const playBtn = button({ label: 'Play', icon: 'play', size: 'sm', onClick: () => (st.playing ? stop() : play()) });
  const tapBtn = button({ label: 'Tap test', size: 'sm', onClick: () => toggleTap() });
  const bestBtn = button({ label: 'Find the best part', size: 'sm', onClick: () => {
    stop();
    st.start = bestPart(analysis, st.len);
    remake();
  } });
  const regenBtn = button({ label: 'Make new notes', size: 'sm', onClick: () => {
    stop();
    st.seed += 1;
    remake();
  } });

  function remake() {
    st.start = Math.max(0, Math.min(st.start, dur - st.len));
    const end = st.start + st.len;
    try {
      st.charts = makeCharts(analysis, { start: st.start, end, seed: st.seed });
      st.error = '';
    } catch (err) {
      st.charts = null;
      st.error = err instanceof ChartError ? `${err.message} Try another part of the song.` : 'Notes could not be made for this part. Try another part of the song.';
    }
    draw();
    onChange(value());
  }

  function draw() {
    replace(lenRow, ...SECTION_CHOICES.map((ms) => h('button', {
      type: 'button',
      class: ['btn', 'btn-sm', st.len === ms ? 'btn-segment-active' : 'btn-segment'],
      disabled: ms > dur,
      attrs: { 'aria-pressed': st.len === ms ? 'true' : 'false' },
      text: `${ms / 1000} s`,
      on: { click: () => {
        stop();
        st.len = ms;
        startInput.max = String(Math.max(0, dur - ms));
        remake();
      } },
    })));
    startInput.value = String(st.start);
    startText.textContent = `Plays ${formatLength(st.start)} to ${formatLength(st.start + st.len)} of ${formatLength(dur)}`;
    offsetText.textContent = `Offset: ${st.offset} ms`;
    const stats = st.charts ? chartStats(st.charts) : null;
    replace(tabs, ...DIFF_IDS.map((id) => h('button', {
      type: 'button',
      class: ['btn', 'btn-sm', st.diff === id ? 'btn-segment-active' : 'btn-segment'],
      attrs: { 'aria-pressed': st.diff === id ? 'true' : 'false' },
      text: stats ? `${DIFF_NAMES[id]} ${stats[id].objects}` : DIFF_NAMES[id],
      on: { click: () => {
        st.diff = id;
        draw();
      } },
    })));
    statLine.textContent = stats ? `${DIFF_NAMES[st.diff]}: ${stats[st.diff].objects} notes, ${stats[st.diff].holds} hold${stats[st.diff].holds === 1 ? '' : 's'}, up to ${stats[st.diff].peak} a second. Tempo ${st.charts.bpm} BPM.` : '';
    status.textContent = st.error;
    status.classList.toggle('is-error', Boolean(st.error));
    playBtn.disabled = !st.charts;
    paintIdle();
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
      paint((audio.currentTime - t0) * 1000);
      raf = win.requestAnimationFrame(loop);
    };
    raf = win.requestAnimationFrame(loop);
  }

  function stop() {
    st.playing = false;
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
    st.start = snapToDownbeat(analysis, Number(startInput.value) || 0);
    remake();
  });
  if (win.document && typeof win.document.addEventListener === 'function') win.document.addEventListener('keydown', onKey);
  tapBtn.setAttribute('aria-pressed', 'false');

  const nudges = OFFSET_STEPS.map((step) => button({ label: `${step > 0 ? '+' : ''}${step}`, size: 'sm', ariaLabel: `Move the notes ${Math.abs(step)} ms ${step > 0 ? 'later' : 'earlier'}`, onClick: () => {
    st.offset = clampOffset(st.offset + step);
    draw();
    onChange(value());
  } }));

  const el = h('div', { class: 'song-editor' },
    h('div', { class: 'song-editor-grid' },
      h('div', { class: 'song-editor-side' },
        h('p', { class: 'field-label', text: 'Length' }), lenRow,
        h('label', { class: 'field-label', htmlFor: startId, text: 'Start' }), startInput, startText,
        h('div', { class: 'song-row' }, bestBtn, regenBtn),
        h('p', { class: 'field-label', text: 'Timing' }),
        h('div', { class: 'song-row' }, ...nudges, offsetText),
        h('p', { class: 'field-help', text: 'If the notes feel early, move them later. If they feel late, move them earlier.' }),
        h('p', { class: 'field-label', text: 'Difficulty' }), tabs, statLine, status),
      h('div', { class: 'song-editor-preview' }, canvas, h('div', { class: 'song-row' }, playBtn, tapBtn), tapText)));

  function value() {
    if (!st.charts) return null;
    return { start_ms: st.start, end_ms: st.start + st.len, offset_ms: st.offset, preview_ms: st.start, charts: st.charts };
  }

  function destroy() {
    stop();
    if (win.document && typeof win.document.removeEventListener === 'function') win.document.removeEventListener('keydown', onKey);
    if (audio && typeof audio.close === 'function') audio.close().catch(() => {});
    audio = null;
    decoded = null;
  }

  remake();
  return { el, value, destroy, state: st, tapAt, nudge: (step) => nudges[OFFSET_STEPS.indexOf(step)].click(), chips: () => [...lenRow.querySelectorAll('button')] };
}
