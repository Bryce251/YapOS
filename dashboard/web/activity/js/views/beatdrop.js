import beatdrop from '../games/beatdrop.js';
import { createRun, LANES, KEYS, WINDOWS, lastNoteAt, multOf } from '../games/beatchart.js';
import { h, memo, timer, plural, button, profileButton } from '../ui/dom.js';
import { sharedLoop, fxLevel } from '../ui/fxmode.js';
import { reducedMotion } from '../ui/fx.js';
import { createBeatPlayer, soundNote } from './beatsynth.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];
export const OFFSET_KEY = 'yapos.party.beatdrop.offset';
export const OFFSET_MAX = 300;
export const CAL_BEATS = 8;
export const CAL_LEAD = 2;
export const CAL_MS = 600;
export const CAL_MIN = 5;
export const CAL_MATCH = 280;
export const PROG_MS = 3000;
export const CATCH_UP = 0.75;
export const LANE_COLORS = Object.freeze(['#f2613f', '#fbbf24', '#22d3ee', '#a78bfa']);
export const JUDGE_TEXT = Object.freeze({ perfect: 'Perfect!', great: 'Great', good: 'Good', miss: 'Miss', mash: 'Too many taps' });
export const MILESTONE = 50;
export const RING_MAX = 26;
export const NOTE_MAX_H = 20;

function defaultStore() {
  try {
    return typeof window !== 'undefined' && window ? window.localStorage || null : null;
  } catch {
    return null;
  }
}

export function clampOffset(ms) {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, n));
}

export function readOffset(store) {
  try {
    const raw = store ? store.getItem(OFFSET_KEY) : null;
    return raw === null || raw === undefined ? 0 : clampOffset(raw);
  } catch {
    return 0;
  }
}

export function writeOffset(store, ms) {
  const v = clampOffset(ms);
  try {
    if (store) store.setItem(OFFSET_KEY, String(v));
  } catch {
    return v;
  }
  return v;
}

export function calibrate(taps, beats) {
  const diffs = [];
  for (const t of taps) {
    let best = null;
    for (const b of beats) if (best === null || Math.abs(t - b) < Math.abs(best)) best = t - b;
    if (best !== null && Math.abs(best) <= CAL_MATCH) diffs.push(best);
  }
  if (diffs.length < CAL_MIN) return null;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const med = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  return { ms: clampOffset(med), n: diffs.length };
}

export function laneOfKey(e) {
  if (!e) return -1;
  const code = typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : null;
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  return KEYS.indexOf(code || key);
}

export function noteY(noteT, t, scroll, hitY) {
  return hitY - ((noteT - t) / scroll) * hitY;
}

export function offsetText(ms) {
  if (!ms) return 'Timing offset: 0 ms';
  return `Timing offset: ${ms > 0 ? '+' : ''}${ms} ms`;
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'ready') {
    if (m.watching) return "You're watching this song.";
    return `${m.readyCount} of ${plural(m.players, 'player', 'players')} ready`;
  }
  if (m.phase === 'play') {
    const done = m.board.filter((b) => b.done).length;
    if (m.waiting) return "You joined near the end of this song, so you're in from the next one.";
    if (m.watching) return `You're watching. ${done} of ${plural(m.players, 'player', 'players')} finished`;
    return `${done} of ${plural(m.players, 'player', 'players')} finished`;
  }
  if (!m.results.length) return 'Nobody played this song.';
  const top = m.results[0];
  return `${top.isMe ? 'You' : top.name} topped the song with ${top.score.toLocaleString('en-US')}!`;
}

function perfNow(w) {
  const p = w && w.performance && typeof w.performance.now === 'function' ? w.performance : typeof performance !== 'undefined' ? performance : null;
  return p ? p.now() : Date.now();
}

function later(w, fn, ms) {
  const set = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : globalThis.setTimeout;
  return set(fn, ms);
}

function cancel(w, id) {
  const clear = typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : globalThis.clearTimeout;
  clear(id);
}

function inDialog(node) {
  for (let n = node, i = 0; n && i < 40; n = n.parentNode, i += 1) {
    if (typeof n.getAttribute === 'function' && (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true')) return true;
  }
  return false;
}

function typing(t) {
  const tag = t && typeof t.localName === 'string' ? t.localName : '';
  return Boolean(t && (t.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select'));
}

function faces(list) {
  if (!list.length) return null;
  return h('span', { class: 'faces' }, list.slice(0, 7).map((p) => profileButton(p, 'sm')), list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null);
}

function show(node, on) {
  if (on) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

function first(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createBeatdropView({ engine, fx, cues, sfx, win, storage } = {}) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || globalThis;
  const store = storage === undefined ? defaultStore() : storage;
  const player = createBeatPlayer({ sfx, win: w });
  const loop = sharedLoop();
  let offset = readOffset(store);
  let snap = null;
  let model = null;
  let gone = false;
  let looping = false;
  let dirty = true;
  let dpr = 1;
  let g2 = null;
  let heard = null;
  let audioN = null;
  let cal = null;
  const calTimers = new Set();
  const local = { n: null, run: null, song: null, sent: false, lastProg: 0, judge: null, shake: -1e9, burst: -1e9, rings: [], down: [false, false, false, false], hit: [-1e9, -1e9, -1e9, -1e9] };

  const el = h('section', { class: 'game game-beatdrop', attrs: { 'aria-label': 'Beat Drop' } });
  const head = h('div', { class: 'beatdrop-headwrap' });
  const note = h('p', { class: 'beatdrop-note muted', attrs: { role: 'note' } });
  const readyBox = h('div', { class: 'beatdrop-ready' });
  const canvas = h('canvas', { class: 'beatdrop-canvas', attrs: { 'aria-label': 'Note highway. Press D, F, J or K, or tap a lane, when a note reaches the line.', role: 'img' } });
  const hudScore = h('strong', { class: 'beatdrop-score fx-num', text: '0' });
  const hudCombo = h('span', { class: 'beatdrop-combo fx-num', text: '' });
  const hudMult = h('span', { class: 'beatdrop-mult', text: '×1' });
  const hud = h('div', { class: 'beatdrop-hud', attrs: { 'aria-live': 'off' } }, h('span', { class: 'beatdrop-hud-cell' }, hudScore, h('span', { class: 'beatdrop-hud-label muted', text: 'Score' })), h('span', { class: 'beatdrop-hud-cell' }, hudCombo, hudMult));
  const msg = h('p', { class: 'beatdrop-msg', attrs: { role: 'status', 'aria-live': 'polite' } });
  const pads = KEYS.map((k, i) =>
    h(
      'button',
      { class: ['beatdrop-pad', `lane-${i}`], type: 'button', dataset: { key: `bd-lane-${i}` }, attrs: { 'aria-label': `Lane ${i + 1}, key ${k.toUpperCase()}` } },
      h('span', { class: 'beatdrop-pad-key', text: k.toUpperCase() }),
    ),
  );
  const padRow = h('div', { class: 'beatdrop-pads' }, pads);
  const stage = h('div', { class: 'beatdrop-stage' }, hud, h('div', { class: 'beatdrop-lanes' }, canvas), padRow, msg);
  const board = h('div', { class: 'beatdrop-board' });
  const resultsBox = h('div', { class: 'beatdrop-results' });
  const calDot = h('span', { class: 'beatdrop-cal-dot', attrs: { 'aria-hidden': 'true' } });
  const calText = h('p', { class: 'beatdrop-cal-text', attrs: { role: 'status', 'aria-live': 'polite' } });
  const calPad = h('button', { class: 'beatdrop-cal-pad spot', type: 'button', dataset: { key: 'bd-cal-tap' } }, calDot, h('span', { class: 'btn-label', text: 'Tap on the beat' }));
  const calBox = h(
    'div',
    { class: 'beatdrop-cal card glass' },
    h('h3', { class: 'beatdrop-cal-title', text: 'Timing check' }),
    calText,
    calPad,
    h('div', { class: 'beatdrop-cal-actions' }, button('Start', { variant: 'primary', size: 'sm', key: 'bd-cal-go', on: () => calStart() }), button('Reset to 0', { variant: 'ghost', size: 'sm', key: 'bd-cal-reset', on: () => calReset() }), button('Done', { variant: 'ghost', size: 'sm', key: 'bd-cal-close', on: () => calClose() })),
  );
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  show(calBox, false);
  el.append(head, note, readyBox, calBox, stage, board, resultsBox, foot);

  function clock() {
    return typeof engine.now === 'function' ? engine.now() : Date.now();
  }

  function still() {
    return reducedMotion(w) || fxLevel() === 'static';
  }

  function lite() {
    return fxLevel() !== 'full';
  }

  function paintNote() {
    const text = model && model.phase !== 'show' ? soundNote(player.status()) : null;
    note.textContent = text || '';
    note.classList.toggle('is-empty', !text);
  }

  function ensureAudio() {
    if (!model || model.phase !== 'play' || !local.song) return;
    if (player.playing && audioN === model.n) return;
    if (player.status() === 'off' || player.status() === 'none') return;
    const now = clock();
    if (now > model.at + local.song.dur * 1000) return;
    if (player.start(local.song, model.at, now)) audioN = model.n;
  }

  function freshRun() {
    if (!model || model.phase !== 'play') return;
    if (local.n === model.n) return;
    const song = beatdrop.songOf(snap);
    const t = (clock() - model.at) / 1000;
    local.n = model.n;
    local.song = song;
    local.sent = false;
    local.lastProg = clock();
    local.judge = null;
    local.rings = [];
    local.run = model.playing && song ? createRun(song, { from: t > -0.25 ? t + CATCH_UP : 0 }) : null;
    dirty = true;
  }

  function sendProg(now) {
    const r = local.run;
    if (!r || local.sent) return;
    local.lastProg = now;
    engine.act({ type: 'prog', n: local.n, s: r.stats.s, c: r.stats.c, j: r.judged });
  }

  function sendDone() {
    const r = local.run;
    if (!r || local.sent) return;
    local.sent = true;
    engine.act({ type: 'done', n: local.n, ...r.final() });
    cue.play(r.stats.m === 0 && r.stats.k === 0 ? 'correct' : 'send');
    paintMsg();
  }

  function handle(evs, now) {
    for (const ev of evs) {
      if (ev.k === 'ghost') continue;
      if (ev.k === 'mash') {
        local.judge = { k: 'mash', at: now, combo: 0 };
        cue.play('error');
        continue;
      }
      local.judge = { k: ev.k, at: now, combo: ev.combo };
      if (ev.k === 'miss') {
        local.shake = now;
        continue;
      }
      local.rings.push({ lane: ev.lane, at: now, k: ev.k });
      if (local.rings.length > 12) local.rings.shift();
      if (ev.combo > 0 && ev.combo % MILESTONE === 0) {
        local.burst = now;
        cue.play('coin');
      }
    }
  }

  function press(lane) {
    if (gone || !model || model.phase !== 'play') return false;
    freshRun();
    if (!local.run || local.sent) return false;
    ensureAudio();
    const now = clock();
    const t = (now - model.at) / 1000 - offset / 1000;
    if (t < -1) return false;
    local.hit[lane] = now;
    handle(local.run.press(lane, t), now);
    paintHud();
    return true;
  }

  function resize() {
    if (typeof canvas.getBoundingClientRect !== 'function') return;
    const r = canvas.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    const ratio = Number(w.devicePixelRatio) || 1;
    dpr = Math.max(1, Math.min(lite() ? 1.25 : 2, ratio));
    const cw = Math.round(r.width * dpr);
    const ch = Math.round(r.height * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    dirty = false;
  }

  function ctx2() {
    if (g2) return g2;
    g2 = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    return g2;
  }

  function rrect(c, x, y, wd, ht, r) {
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(x, y, wd, ht, r);
    else c.rect(x, y, wd, ht);
    c.fill();
  }

  function draw(t, now) {
    const c = ctx2();
    if (!c || !local.song) return;
    if (dirty) resize();
    const W = canvas.width;
    const H = canvas.height;
    if (!(W > 0 && H > 0)) return;
    const song = local.song;
    const calm = still();
    const full = !lite() && !calm;
    const lw = W / LANES;
    const hitY = H * 0.86;
    const ring = Math.min(lw * 0.3, RING_MAX * dpr);
    const scroll = song.scroll;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    const age = now - local.shake;
    if (full && age < 160) c.translate(Math.sin(now * 0.09) * 5 * dpr * (1 - age / 160), 0);
    for (let l = 0; l < LANES; l += 1) {
      c.globalAlpha = 1;
      c.fillStyle = l % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.055)';
      c.fillRect(l * lw, 0, lw, H);
      const lit = local.down[l] || now - local.hit[l] < 110;
      if (lit) {
        c.globalAlpha = 0.16;
        c.fillStyle = LANE_COLORS[l];
        c.fillRect(l * lw, 0, lw, H);
      }
    }
    c.globalAlpha = 1;
    const beat = song.beat;
    const b0 = Math.max(0, Math.floor((t - 0.2) / beat));
    for (let b = b0; b * beat <= t + scroll; b += 1) {
      const y = noteY(b * beat, t, scroll, hitY);
      c.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      c.fillRect(0, y, W, Math.max(1, dpr));
    }
    const onBeat = t >= 0 && (t % beat) < 0.09;
    for (let l = 0; l < LANES; l += 1) {
      const cx = l * lw + lw / 2;
      c.strokeStyle = LANE_COLORS[l];
      c.lineWidth = 2 * dpr;
      c.globalAlpha = onBeat && !calm ? 1 : 0.7;
      c.beginPath();
      c.arc(cx, hitY, ring, 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = 0.85;
      c.fillStyle = '#f4f4f5';
      c.font = `600 ${Math.round(13 * dpr)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(KEYS[l].toUpperCase(), cx, hitY);
    }
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.fillRect(0, hitY - dpr, W, 2 * dpr);
    const notes = song.notes;
    const mark = local.run ? local.run.mark : null;
    const nh = Math.max(10 * dpr, Math.min(lw * 0.2, NOTE_MAX_H * dpr));
    const nw = lw * 0.76;
    if (full) c.shadowBlur = 14 * dpr;
    for (let i = first(notes, t - 0.3); i < notes.length && notes[i].t <= t + scroll; i += 1) {
      const n = notes[i];
      const m = mark ? mark[i] : 0;
      if (m >= 1 && m <= 3) continue;
      const y = noteY(n.t, t, scroll, hitY);
      c.globalAlpha = m === 4 || m === 5 ? 0.25 : 1;
      c.fillStyle = LANE_COLORS[n.l];
      if (full) c.shadowColor = LANE_COLORS[n.l];
      rrect(c, n.l * lw + (lw - nw) / 2, y - nh / 2, nw, nh, nh / 2);
    }
    c.shadowBlur = 0;
    c.globalAlpha = 1;
    local.rings = local.rings.filter((r) => now - r.at < 240);
    for (const r of local.rings) {
      const k = (now - r.at) / 240;
      c.globalAlpha = 0.8 * (1 - k);
      c.strokeStyle = r.k === 'perfect' ? '#fafafa' : LANE_COLORS[r.lane];
      c.lineWidth = 3 * dpr;
      c.beginPath();
      c.arc(r.lane * lw + lw / 2, hitY, ring * (full ? 1 + 0.6 * k : 1.13), 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    const j = local.judge;
    if (j && now - j.at < 650) {
      const k = (now - j.at) / 650;
      c.globalAlpha = 1 - k;
      c.fillStyle = j.k === 'perfect' ? '#4ade80' : j.k === 'great' ? '#60a5fa' : j.k === 'good' ? '#fbbf24' : '#f87171';
      const grow = full ? 1 + 0.12 * (1 - k) : 1;
      c.font = `800 ${Math.round(26 * dpr * grow)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(JUDGE_TEXT[j.k] || '', W / 2, hitY - H * 0.26);
      if (j.combo >= 5) {
        c.font = `700 ${Math.round(16 * dpr)}px system-ui, sans-serif`;
        c.fillStyle = '#f4f4f5';
        c.fillText(`${j.combo} combo`, W / 2, hitY - H * 0.26 + 28 * dpr);
      }
    }
    c.globalAlpha = 1;
    if (t < 0) {
      const n = Math.ceil(-t);
      c.fillStyle = '#f4f4f5';
      c.font = `800 ${Math.round(56 * dpr)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(n > 3 ? 'Get ready' : String(n), W / 2, H * 0.4);
    }
    const prog = Math.max(0, Math.min(1, t / Math.max(1, song.dur)));
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(0, 0, W, 3 * dpr);
    c.fillStyle = '#f2613f';
    c.fillRect(0, 0, W * prog, 3 * dpr);
    const bAge = now - local.burst;
    if (full && bAge < 220) {
      c.globalAlpha = 0.14 * (1 - bAge / 220);
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, W, H);
      c.globalAlpha = 1;
    }
  }

  let hudSig = '';
  function paintHud() {
    const r = local.run;
    const s = r ? r.stats.s : 0;
    const cur = r ? r.stats.cur : 0;
    const mult = multOf(cur);
    const sig = `${s}|${cur}|${mult}`;
    if (sig === hudSig) return;
    hudSig = sig;
    hudScore.textContent = s.toLocaleString('en-US');
    hudCombo.textContent = cur >= 2 ? `${cur} combo` : '';
    hudMult.textContent = `×${mult}`;
    hud.classList.toggle('is-hot', mult >= 4);
  }

  function paintMsg() {
    let text = '';
    if (model && model.phase === 'play') {
      if (model.waiting) text = "You're in from the next song. Watch this one!";
      else if (model.watching) text = "You're watching this song.";
      else if (local.sent) text = 'Song done! Waiting for the others…';
    }
    msg.textContent = text;
    msg.classList.toggle('is-empty', !text);
  }

  function frame() {
    if (gone || !model || model.phase !== 'play' || !local.song) {
      looping = false;
      return false;
    }
    const now = clock();
    const t = (now - model.at) / 1000;
    if (local.run && !local.sent) {
      const tj = t - offset / 1000;
      handle(local.run.tick(tj), now);
      if (now - local.lastProg >= PROG_MS && t > 0) sendProg(now);
      if (tj > lastNoteAt(local.song) + WINDOWS.good + 0.25) {
        handle(local.run.tick(tj + 10), now);
        sendDone();
      }
    }
    draw(t, now);
    paintHud();
    if (t > local.song.dur + 1.5) {
      looping = false;
      return false;
    }
    return true;
  }

  function startLoop() {
    if (looping || gone) return;
    looping = true;
    dirty = true;
    loop.add(frame);
  }

  function calClear() {
    for (const id of calTimers) cancel(w, id);
    calTimers.clear();
  }

  function calOpen() {
    calClear();
    cal = { on: false, beats: [], taps: [] };
    calText.textContent = `Press Start, then tap the pad or D F J K on each of the ${CAL_BEATS} beats after the first ${CAL_LEAD} clicks. ${offsetText(offset)}.`;
    calDot.classList.remove('is-on');
    show(calBox, true);
  }

  function calClose() {
    calClear();
    cal = null;
    show(calBox, false);
    paintReady(readyBox, readyModel(model));
  }

  function calReset() {
    offset = writeOffset(store, 0);
    calText.textContent = `${offsetText(offset)}. Press Start to measure again.`;
    paintReady(readyBox, readyModel(model));
  }

  function calStart() {
    if (!cal) calOpen();
    calClear();
    const t0 = perfNow(w) + 700;
    cal.on = true;
    cal.taps = [];
    cal.beats = [];
    for (let i = 0; i < CAL_LEAD + CAL_BEATS; i += 1) {
      const at = t0 + i * CAL_MS;
      if (i >= CAL_LEAD) cal.beats.push(at);
      player.click((at - perfNow(w)) / 1000, i < CAL_LEAD);
      calTimers.add(later(w, () => {
        calDot.classList.add('is-on');
        calTimers.add(later(w, () => calDot.classList.remove('is-on'), 110));
      }, Math.max(0, at - perfNow(w))));
    }
    calText.textContent = 'Listen to the first clicks, then tap along…';
    calTimers.add(later(w, () => calFinish(), t0 - perfNow(w) + (CAL_LEAD + CAL_BEATS) * CAL_MS + 300));
  }

  function calTap() {
    if (!cal || !cal.on) return false;
    cal.taps.push(perfNow(w));
    return true;
  }

  function calFinish() {
    if (!cal) return null;
    cal.on = false;
    const got = calibrate(cal.taps, cal.beats);
    if (!got) {
      calText.textContent = `Not enough taps landed on the beat. Try again. ${offsetText(offset)}.`;
      return null;
    }
    offset = writeOffset(store, got.ms);
    calText.textContent = `Saved! ${offsetText(offset)}. ${got.ms > 40 ? 'Notes will be judged a little later for you.' : got.ms < -40 ? 'Notes will be judged a little earlier for you.' : 'Your timing is spot on.'}`;
    paintReady(readyBox, readyModel(model));
    return got;
  }

  calPad.addEventListener('pointerdown', (e) => {
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    calTap();
  });

  function onKey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (typing(t) || inDialog(t)) return;
    const lane = laneOfKey(e);
    if (cal && cal.on && (lane >= 0 || e.key === ' ')) {
      if (e.repeat) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      calTap();
      return;
    }
    if (lane < 0 || !model || model.phase !== 'play') return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (e.repeat) return;
    local.down[lane] = true;
    pads[lane].classList.add('is-down');
    press(lane);
  }

  function onKeyUp(e) {
    const lane = laneOfKey(e);
    if (lane < 0) return;
    local.down[lane] = false;
    pads[lane].classList.remove('is-down');
  }

  pads.forEach((pad, i) => {
    pad.addEventListener('pointerdown', (e) => {
      if (e && typeof e.button === 'number' && e.button !== 0) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      pad.classList.add('is-down');
      press(i);
    });
    const up = () => pad.classList.remove('is-down');
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointerleave', up);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    const wd = canvas.clientWidth || 0;
    if (!(wd > 0) || !Number.isFinite(e.offsetX)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    press(Math.max(0, Math.min(LANES - 1, Math.floor((e.offsetX / wd) * LANES))));
  });

  const keyTarget = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function' ? document : null;
  if (keyTarget) {
    keyTarget.addEventListener('keydown', onKey);
    keyTarget.addEventListener('keyup', onKeyUp);
  }
  const onResize = () => {
    dirty = true;
  };
  if (typeof w.addEventListener === 'function') w.addEventListener('resize', onResize);
  const sfxOff = player.sfx && typeof player.sfx.on === 'function'
    ? player.sfx.on('change', () => {
        paintNote();
        ensureAudio();
      })
    : null;

  function sendReady(m) {
    if (!m || m.phase !== 'ready' || m.iReady || m.watching) return;
    const s = player.sfx;
    if (s && typeof s.unlock === 'function') {
      try {
        s.unlock();
      } catch {
        audioN = null;
      }
    }
    cue.play('send');
    engine.act({ type: 'ready', n: m.n });
  }

  function readyModel(m) {
    if (!m || m.phase !== 'ready') return null;
    return { n: m.n, style: m.style, diffName: m.diffName, notes: m.notes, len: m.len, iReady: m.iReady, watching: m.watching, readyBy: m.readyBy, offset, cal: Boolean(cal) };
  }

  const paintReady = memo((r) => {
    if (!r) return null;
    return h(
      'div',
      { class: 'beatdrop-ready-card card glass' },
      h('h2', { class: 'question beatdrop-title fx-display', text: `${r.style.emoji} ${r.style.name}` }),
      h(
        'ul',
        { class: 'beatdrop-facts' },
        h('li', { text: `${r.style.bpm} BPM` }),
        h('li', { text: r.diffName }),
        h('li', { text: `${r.notes} notes` }),
        h('li', { text: `${r.len} s` }),
      ),
      h('p', { class: 'beatdrop-how muted', text: 'Hit each note as it crosses the line: D F J K on a keyboard, or tap the lanes. Perfect hits and long combos score the most.' }),
      h('p', { class: 'beatdrop-offset muted', text: offsetText(r.offset) }),
      h(
        'div',
        { class: 'beatdrop-ready-actions' },
        r.watching ? null : button(r.iReady ? 'Ready!' : "I'm ready", { variant: 'primary', key: 'bd-ready', disabled: r.iReady, on: () => sendReady(model) }),
        r.cal ? null : button('Check my timing', { variant: 'ghost', size: 'sm', key: 'bd-cal-open', on: () => calOpen() }),
      ),
      faces(r.readyBy),
    );
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: '🥁 Beat Drop' }),
      h('span', { class: 'game-count', text: `Song ${m.number} of ${m.total}` }),
      h('span', { class: 'beatdrop-tag', text: `${m.style.emoji} ${m.style.name} · ${m.diffName}` }),
      m.phase === 'ready' ? timer(m.starts, m.ends, 'Song starts in') : m.phase === 'show' ? timer(m.starts, m.ends, m.last ? 'Results in' : 'Next song in') : null,
    ),
  );

  const paintBoard = memo((b) => {
    if (!b || !b.rows.length) return null;
    return h(
      'ol',
      { class: 'beatdrop-live' },
      b.rows.slice(0, 8).map((p, i) =>
        h(
          'li',
          { class: ['beatdrop-live-row', p.isMe ? 'is-me' : null, p.done ? 'is-done' : null], vars: { '--pct': (p.pct / 100).toFixed(2), '--i': i } },
          profileButton(p, 'xs'),
          h('span', { class: 'beatdrop-live-name', text: p.isMe ? 'You' : p.name }),
          h('span', { class: 'beatdrop-live-score fx-num', text: p.score.toLocaleString('en-US') }),
          h('span', { class: 'beatdrop-live-bar', attrs: { 'aria-hidden': 'true' } }),
        ),
      ),
    );
  });

  const paintResults = memo((r) => {
    if (!r) return null;
    return h(
      'ol',
      { class: 'beatdrop-res' },
      r.rows.map((x, i) =>
        h(
          'li',
          { class: ['beatdrop-res-row', x.isMe ? 'is-me' : null, x.fc ? 'is-fc' : null], vars: { '--i': i } },
          h('span', { class: 'beatdrop-res-place', text: MEDALS[x.place - 1] || String(x.place), attrs: { 'aria-hidden': 'true' } }),
          profileButton(x, 'sm'),
          h('span', { class: 'beatdrop-res-name', text: x.isMe ? 'You' : x.name }),
          h('span', { class: ['beatdrop-grade', `grade-${x.grade.toLowerCase()}`], text: x.grade, attrs: { title: `Grade ${x.grade}` } }),
          h('span', { class: 'beatdrop-res-stats muted', text: x.hits ? `${x.acc}% · ${x.combo} best combo${x.fc ? ' · Full combo' : ''}` : x.done ? 'Done' : 'Did not finish' }),
          h('span', { class: 'beatdrop-res-score fx-num', text: x.score.toLocaleString('en-US') }),
          h('span', { class: ['beatdrop-res-pts', x.pts ? null : 'is-zero'], text: x.pts ? `+${x.pts.toLocaleString('en-US')}` : '0' }),
        ),
      ),
    );
  });

  function update(next) {
    if (gone) return;
    snap = next;
    const m = next ? beatdrop.model(next) : null;
    model = m;
    if (!m) {
      paintReady(readyBox, null);
      show(stage, false);
      return;
    }
    paintHead(head, { number: m.number, total: m.total, style: m.style, diffName: m.diffName, phase: m.phase, starts: m.starts, ends: m.ends, last: m.last });
    el.dataset.phase = m.phase;
    paintReady(readyBox, readyModel(m));
    show(readyBox, m.phase === 'ready');
    const playing = m.phase === 'play';
    show(stage, playing);
    show(board, playing);
    show(resultsBox, m.phase === 'show');
    if (playing) {
      freshRun();
      ensureAudio();
      startLoop();
      paintBoard(board, { rows: m.board.map((b) => ({ id: b.id, name: b.name, initials: b.initials, hue: b.hue, avatar: b.avatar, isMe: b.isMe, score: b.score, pct: b.pct, done: b.done })) });
    } else {
      player.stop();
      audioN = null;
    }
    if (playing && cal) calClose();
    paintResults(resultsBox, m.phase === 'show' ? { rows: m.results } : null);
    foot.textContent = footText(m);
    paintNote();
    paintMsg();
    const beat = `${m.n}:${m.phase}`;
    if (heard !== beat) {
      const was = heard;
      heard = beat;
      if (was && m.phase === 'show') {
        cue.play('reveal');
        const rows = resultsBox.querySelector('.beatdrop-res');
        if (rows) rows.classList.add('fx-stagger');
        if (m.mine && m.mine.place === 1 && m.results.length > 1 && fx && typeof fx.confetti === 'function') fx.confetti(40);
        if (m.mine && m.mine.fc) {
          const row = resultsBox.querySelector('.beatdrop-res-row.is-me');
          if (row) cue.burst(row, { count: 14, emoji: ['🎯', '🥁'] });
        }
      }
      if (was && m.phase === 'play') cue.play('start');
    }
  }

  function destroy() {
    gone = true;
    looping = false;
    calClear();
    player.destroy();
    if (typeof sfxOff === 'function') sfxOff();
    if (keyTarget) {
      keyTarget.removeEventListener('keydown', onKey);
      keyTarget.removeEventListener('keyup', onKeyUp);
    }
    if (typeof w.removeEventListener === 'function') w.removeEventListener('resize', onResize);
  }

  paintNote();

  return {
    el,
    update,
    destroy,
    press,
    frame,
    player,
    calOpen,
    calStart,
    calTap,
    calFinish,
    get offset() {
      return offset;
    },
    get run() {
      return local.run;
    },
  };
}
