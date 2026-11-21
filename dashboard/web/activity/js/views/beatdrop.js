import beatdrop, { GOAL, SCORE_LINE, FLAG_SAT, FLAG_LEFT, LOAD_FAIL_TEXT, LATE_LOAD_TEXT, LATE_LOAD_LAST, ADULT_LABEL } from '../games/beatdrop.js';
import { createJudge, lookFor, scoreOf, accOf, tierOf, lastNoteAt, sectionMarks, countOf, TIERS, LANES } from '../games/beatchart.js';
import { loadChart, loadCatalog, chartSong, lengthLabel } from '../games/beatsongs.js';
import { h, memo, timer, plural, button, profileButton } from '../ui/dom.js';
import { sharedLoop, fxLevel } from '../ui/fxmode.js';
import { reducedMotion } from '../ui/fx.js';
import { createBeatPlayer, soundNote } from './beatsynth.js';
import { createSongAudio, songSpan } from './beatsong.js';
import { createBeatDraw, laneStyle } from './beatdraw.js';
import { createTutorial, clampOffset, tapText, TIMING_MAX } from './beattut.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];
const SHAPE_ICON = ['●', '◆', '■', '▲'];
export const OFFSET_KEY = 'yapos.party.beatdrop.offset';
export const PLAY_SHEET = '/activity/css/beatdrop-play.css';
export const SONG_SHEET = '/activity/css/beatdrop-songs.css';
export const LOAD_MS = 20000;
export const LOAD_MAX_MS = 90000;
export const PROG_MS = 1500;
export const ANCHOR_SAMPLES = 5;
export const ANCHOR_SPAN_MS = 500;
export const RESAMPLE_MS = 2000;
export const JUMP_MS = 250;
export const SLEW_MIN_MS = 80;
export const SLEW_STEP_MS = 1;
export const RECHECK_N = 3;
export const AUDIO_DRIFT_S = 0.15;
export const MISS_GRACE_MS = 34;
export const MEDIA_TTL_MS = 1000;
export const DROP_HOLD_S = 2;
export const LITE_MS = 34;
export const LITE_SPAN_MS = 2000;
export const HUD_H = 44;
export const TICK_H = 28;
export const PAD_H = 52;
export const SAFE_H = 12;
export const MIN_H = 320;
export const MAX_H = 760;
export const WIDE_PX = 900;
export const GAPS_H = 8;
export const FIX_MIN_HITS = 20;
export const FIX_MIN_MS = 25;
export const TOAST_MS = 1500;
export const TOAST_GAP_MS = 2000;
export const LOST_MIN = 10;
export const LOST_MS = 600;
export const BANNER_MS = 1200;
export const LANE_KEYS = Object.freeze({
  4: Object.freeze([Object.freeze(['KeyD', 'ArrowLeft']), Object.freeze(['KeyF', 'ArrowDown']), Object.freeze(['KeyJ', 'ArrowUp']), Object.freeze(['KeyK', 'ArrowRight'])]),
});
const DEFAULT_PREFS = Object.freeze({ tapOffset: 0, seen: false, slow: null, calm: false, music: true, speed: 1, keys: null, dir: 'down', panel: true });
export const DIRS = Object.freeze(['down', 'up']);
export const NUDGE_MS = 5;

export function cleanDir(v) {
  return v === 'up' ? 'up' : 'down';
}

export function offsetLabel(ms) {
  const n = clampOffset(ms);
  return `${n > 0 ? '+' : ''}${n} ms`;
}
const BLOCKED_KEYS = new Set(['Escape', 'Tab', 'Enter', 'NumpadEnter', 'Backspace', 'CapsLock', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu', 'OSLeft', 'OSRight']);

export function okKey(code) {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code) && !BLOCKED_KEYS.has(code);
}

export function cleanKeys(v) {
  if (!Array.isArray(v) || v.length !== LANES) return null;
  if (!v.every(okKey) || new Set(v).size !== v.length) return null;
  return v.slice();
}

export function bindsFor(keys) {
  const k = cleanKeys(keys);
  return k ? k.map((x) => [x]) : LANE_KEYS[LANES];
}

const ARROW_NAMES = Object.freeze({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' });

export function keyName(code) {
  const c = String(code || '');
  if (ARROW_NAMES[c]) return ARROW_NAMES[c];
  if (c === 'Space') return 'Space';
  return c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}
export const SPEEDS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]);

export function cleanSpeed(v) {
  const n = Number(v);
  return SPEEDS.includes(n) ? n : 1;
}

export function speedLabel(v) {
  return `${cleanSpeed(v)}x`;
}

export function stepSpeed(v, dir) {
  const i = SPEEDS.indexOf(cleanSpeed(v));
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + (dir > 0 ? 1 : -1)))];
}

function defaultStore() {
  try {
    return typeof window !== 'undefined' && window ? window.localStorage || null : null;
  } catch {
    return null;
  }
}

export function readPrefs(store) {
  const out = { ...DEFAULT_PREFS, best: {} };
  let raw = null;
  try {
    raw = store ? store.getItem(OFFSET_KEY) : null;
  } catch {
    raw = null;
  }
  if (raw === null || raw === undefined) return out;
  const text = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    out.tapOffset = clampOffset(text);
    return out;
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') return out;
    out.tapOffset = clampOffset(v.tapOffset);
    out.seen = v.seen === true;
    out.slow = typeof v.slow === 'boolean' ? v.slow : null;
    out.calm = v.calm === true;
    out.music = v.music !== false;
    out.speed = cleanSpeed(v.speed);
    out.keys = cleanKeys(v.keys);
    out.dir = cleanDir(v.dir);
    out.panel = v.panel !== false;
    if (v.best && typeof v.best === 'object') {
      for (const [k, n] of Object.entries(v.best)) if (/^[a-z0-9-]{1,20}\.[0-3]$/.test(k) && Number.isInteger(n) && n >= 0 && n <= 1000) out.best[k] = n;
    }
  } catch {
    return out;
  }
  return out;
}

export function writePrefs(store, prefs) {
  const v = { tapOffset: clampOffset(prefs.tapOffset), seen: Boolean(prefs.seen), slow: typeof prefs.slow === 'boolean' ? prefs.slow : null, calm: Boolean(prefs.calm), music: prefs.music !== false, speed: cleanSpeed(prefs.speed), keys: cleanKeys(prefs.keys), dir: cleanDir(prefs.dir), panel: prefs.panel !== false, best: prefs.best || {} };
  try {
    if (store) store.setItem(OFFSET_KEY, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

export function keyCodeOf(e) {
  if (!e) return '';
  if (typeof e.code === 'string' && e.code) return e.code;
  const k = typeof e.key === 'string' ? e.key : '';
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (k === 'Escape' || k === 'Esc') return 'Escape';
  if (/^Arrow(Left|Right|Up|Down)$/.test(k)) return k;
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  return '';
}

export function laneOfKey(e, keys) {
  const code = keyCodeOf(e);
  return bindsFor(keys).findIndex((list) => list.includes(code));
}

export function keyLabels(keys) {
  return bindsFor(keys).map((list) => keyName(list[0]));
}

export function heightFor(innerHeight, top = 0, wide = false, pads = true) {
  const ih = Number(innerHeight) || 700;
  const room = ih - Math.max(0, top) - HUD_H - (wide ? 0 : TICK_H) - (pads ? PAD_H : 0) - SAFE_H - GAPS_H;
  return Math.round(Math.max(MIN_H, Math.min(MAX_H, room)));
}

export function widthFor(lanes = LANES) {
  return Math.min(130 * lanes + 40, 560);
}

export function loadText(state) {
  if (state === 'ok') return 'Song loaded.';
  if (state === 'fail') return `${LOAD_FAIL_TEXT}.`;
  return 'Loading the song...';
}

export function songLine(song) {
  if (!song || !song.title) return '';
  return song.artist ? `${song.title} - ${song.artist}` : song.title;
}

export function adultTag(song) {
  return song && song.adult === true ? h('span', { class: 'bd-adult', text: ADULT_LABEL, attrs: { title: 'This song is for adults (18+)' } }) : null;
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function tendencyOf(dts) {
  const list = Array.isArray(dts) ? dts.filter(Number.isFinite) : [];
  const med = Math.round(median(list));
  const label = !list.length ? '' : med > 15 ? 'Mostly late' : med < -15 ? 'Mostly early' : 'On time';
  const fix = list.length >= FIX_MIN_HITS && Math.abs(med) > FIX_MIN_MS ? med : 0;
  return { label, ms: med, fix, n: list.length };
}

export function ordinal(n) {
  const v = Math.abs(Math.round(Number(n) || 0));
  const t = v % 100;
  const suf = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${v}${suf}`;
}

export function rivalLine(rows, me, myScore) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => (r.isMe ? { ...r, score: myScore } : r));
  if (!list.some((r) => r.isMe)) list.push({ isMe: true, name: 'You', score: myScore, slot: me });
  list.sort((a, b) => b.score - a.score || (a.isMe ? -1 : 0) || (b.isMe ? 1 : 0));
  const idx = list.findIndex((r) => r.isMe);
  if (list.length < 2) return { text: `Solo run - ${myScore} points`, gap: 0, rank: 1, rival: null };
  const rival = idx > 0 ? list[idx - 1] : list[1];
  const gap = rival.score - myScore;
  const place = `You're ${ordinal(idx + 1)} of ${list.length}`;
  const text = gap === 0 ? `${place} - tied with ${rival.name}` : gap > 0 ? `${place} - ${gap} behind ${rival.name}` : `${place} - ${-gap} ahead of ${rival.name}`;
  return { text, gap: Math.abs(gap), rank: idx + 1, rival: rival.slot };
}

export function evText(ev, nameOf) {
  if (!Array.isArray(ev)) return '';
  const [slot, kind, n] = ev;
  const who = nameOf(slot);
  if (kind === 't') return `${who} hit a ${n} streak!`;
  if (kind === 'f') return `${who} finished with a full streak!`;
  if (kind === 'l') return `${who} took the lead!`;
  return '';
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'ready') {
    if (m.watching) return "You're watching. You're in from the next song.";
    return `${m.readyCount} of ${plural(m.players, 'player', 'players')} ready`;
  }
  if (m.phase === 'play') {
    const done = m.board.filter((b) => b.done).length;
    if (m.watching) return `Watching. ${done} of ${plural(m.players, 'player', 'players')} finished`;
    return `${done} of ${plural(m.players, 'player', 'players')} finished`;
  }
  if (m.skipped) return m.last ? '' : 'Moving on to the next song.';
  const top = m.results.find((r) => r.flag === 0);
  if (!top) return 'Nobody played this song.';
  return `${top.isMe ? 'You' : top.name} topped the song with ${top.score} / 1000!`;
}

export function createSongClock({ perf, hostNow, audio = () => null, outLat = () => 0, onShift = () => {} } = {}) {
  const pnow = typeof perf === 'function' ? perf : () => Date.now();
  const hnow = typeof hostNow === 'function' ? hostNow : () => Date.now();
  const st = { at: null, anchor: 0, samples: [], recent: [], frozen: false, first: 0, last: 0, target: null, zero: null, mapped: false, offset: 0 };

  function sample() {
    return pnow() + (st.at - hnow());
  }

  function audioCheck(p) {
    if (!st.mapped) return null;
    const c = running();
    if (!c) return null;
    const fresh = Number(c.currentTime) + (st.anchor - p) / 1000;
    if (st.zero !== null && Math.abs(fresh - st.zero) <= AUDIO_DRIFT_S) return null;
    st.zero = fresh;
    onShift(st.zero, 'jump');
    return 'audio';
  }

  function running() {
    const c = audio();
    return c && c.state === 'running' ? c : null;
  }

  function remap() {
    if (st.zero === null) return;
    const c = running();
    if (!c) {
      st.zero = null;
      return;
    }
    st.zero = Number(c.currentTime) + (st.anchor - pnow()) / 1000;
    onShift(st.zero, 'slew');
  }

  function setAnchor(v, kind) {
    st.anchor = v;
    if (st.zero !== null) {
      const c = running();
      if (c) {
        st.zero = Number(c.currentTime) + (st.anchor - pnow()) / 1000;
        onShift(st.zero, kind);
      } else st.zero = null;
    }
  }

  const api = {
    reset(at) {
      st.at = Number(at) || 0;
      st.samples = [sample()];
      st.anchor = st.samples[0];
      st.recent = [];
      st.first = pnow();
      st.last = st.first;
      st.frozen = false;
      st.target = null;
      st.zero = null;
      st.mapped = false;
    },
    step({ hold = false } = {}) {
      if (st.at === null) return 'none';
      const p = pnow();
      let out = 'ok';
      if (!st.frozen) {
        if (st.samples.length < ANCHOR_SAMPLES && p - st.first >= st.samples.length * (ANCHOR_SPAN_MS / (ANCHOR_SAMPLES - 1))) {
          st.samples.push(sample());
          setAnchor(median(st.samples), 'settle');
        }
        if (st.samples.length >= ANCHOR_SAMPLES) {
          st.frozen = true;
          st.recent = [st.anchor];
          st.last = p;
        }
      } else if (p - st.last >= RESAMPLE_MS) out = api.check();
      if (st.target !== null && !hold) {
        const d = st.target - st.anchor;
        const stepMs = Math.max(-SLEW_STEP_MS, Math.min(SLEW_STEP_MS, d));
        setAnchor(st.anchor + stepMs, 'slew');
        if (Math.abs(st.target - st.anchor) < 1e-6) st.target = null;
      }
      const a = audioCheck(pnow());
      return out === 'ok' && a ? a : out;
    },
    check() {
      st.last = pnow();
      st.recent.push(sample());
      if (st.recent.length > RECHECK_N) st.recent.splice(0, st.recent.length - RECHECK_N);
      const s = median(st.recent);
      const d = s - st.anchor;
      if (Math.abs(d) > JUMP_MS) {
        st.target = null;
        setAnchor(s, 'jump');
        return 'jump';
      }
      if (Math.abs(d) > SLEW_MIN_MS) {
        st.target = s;
        return 'slew';
      }
      st.target = null;
      return 'ok';
    },
    reanchor() {
      st.target = null;
      st.last = pnow();
      const s = sample();
      st.recent = [s];
      setAnchor(s, 'jump');
    },
    mapAudio() {
      const c = running();
      st.zero = c ? Number(c.currentTime) + (st.anchor - pnow()) / 1000 : null;
      st.mapped = st.zero !== null;
      return st.zero;
    },
    songT() {
      const c = st.zero !== null ? running() : null;
      if (c) return Number(c.currentTime) - st.zero - (Number(outLat()) || 0);
      return (pnow() - st.anchor) / 1000;
    },
    fromPerf(ts) {
      const p = pnow();
      const at = Number.isFinite(ts) ? ts : p;
      return api.songT() + (at - p) / 1000;
    },
    gameT() {
      return api.songT() - st.offset / 1000;
    },
    judgeT(ts) {
      return api.fromPerf(ts) - st.offset / 1000;
    },
    get anchor() {
      return st.anchor;
    },
    get zero() {
      return st.zero;
    },
    get frozen() {
      return st.frozen;
    },
    get slewing() {
      return st.target !== null;
    },
    get offset() {
      return st.offset;
    },
    set offset(v) {
      st.offset = clampOffset(v);
    },
  };
  remap();
  return api;
}

function addSheet(doc, href, mark) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  const found = typeof doc.querySelector === 'function' ? doc.querySelector(`link[${mark}]`) : null;
  if (found) return true;
  const host = doc.head || doc.body;
  if (!host) return false;
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', href);
  link.setAttribute(mark, '');
  host.append(link);
  return true;
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

export function eventTime(ts, now) {
  return Number.isFinite(ts) && ts > 0 && ts <= now + 5 && ts >= now - 1000 ? ts : now;
}

function show(node, on) {
  if (on) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

let setIds = 0;

function switchBtn(on, key, labelId, fn) {
  return h('button', { class: ['bd-sw', on ? 'is-on' : null], type: 'button', dataset: { key }, attrs: { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-labelledby': labelId }, on: { click: fn } }, h('span', { class: 'switch-track', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'switch-thumb' })), h('span', { class: 'bd-sw-text', text: on ? 'On' : 'Off', attrs: { 'aria-hidden': 'true' } }));
}

function segBtn(label, on, key, fn, extra = {}) {
  return h('button', { class: ['bd-seg-btn', on ? 'is-on' : null], type: 'button', dataset: { key }, disabled: extra.disabled, attrs: { 'aria-pressed': extra.plain ? null : on ? 'true' : 'false', 'aria-label': extra.label || null }, on: { click: fn } }, label);
}

function setRow(id, label, hint, ...control) {
  return h('div', { class: 'bd-set-row' }, h('div', { class: 'bd-set-lab' }, h('span', { class: 'bd-set-name', text: label, attrs: { id } }), hint ? h('span', { class: 'bd-set-hint', text: hint }) : null), h('div', { class: 'bd-set-ctl' }, ...control));
}

function setGroup(title, ...rows) {
  return h('div', { class: 'bd-set-grp', attrs: { role: 'group', 'aria-label': title } }, h('h3', { class: 'bd-set-gt', text: title }), ...rows);
}

export function createBeatdropView({ engine, fx, cues, sfx, win, storage, doc, songAudio } = {}) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || globalThis;
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const store = storage === undefined ? defaultStore() : storage;
  const player = createBeatPlayer({ sfx, win: w });
  const audio = songAudio || createSongAudio({ win: w });
  const loop = sharedLoop();
  const prefs = readPrefs(store);
  setIds += 1;
  const uid = `bd${setIds}`;
  addSheet(d, PLAY_SHEET, 'data-bd-play');
  addSheet(d, SONG_SHEET, 'data-bd-songs');
  loadCatalog().catch(() => null);
  const load = { n: null, state: 'idle', pct: 0, try: 0 };
  let holdSig = '';
  let snap = null;
  let model = null;
  let gone = false;
  let looping = false;
  let heard = null;
  let tut = null;
  let autoTried = false;
  let keysSeen = false;
  let lite = false;
  let layoutN = null;
  let layoutSig = '';
  let canvasSig = '';
  let liveAt = 0;
  let toastAt = -1e9;
  let toastUntil = -1e9;
  let lastEv = 0;
  let rivalGap = null;
  let fixInfo = null;
  let bestInfo = null;
  const held = new Set();
  let binding = null;
  const pointers = new Map();
  const sideRows = new Map();
  const local = { n: null, song: null, lanes: LANES, songOn: false, judge: null, demo: false, mark: null, sent: false, lastProg: 0, marks: [], drops: [], look: 1.7, pressAt: new Float64Array(4).fill(-1e9), missAt: new Float64Array(4).fill(-1e9), down: [false, false, false, false], flash: [null, null, null, null], judgeFx: [null, null, null, null], shakeAt: -1e9, count: null, audioOn: false, audioWant: false, hiddenAt: null, hiddenMs: 0, frames: [], spanStart: 0, lostAt: -1e9, bannerAt: -1e9, announced: false, demoAt: 0 };

  function perf() {
    const p = w && w.performance && typeof w.performance.now === 'function' ? w.performance : typeof performance !== 'undefined' ? performance : null;
    return p ? p.now() : Date.now();
  }

  function hostNow() {
    return typeof engine.now === 'function' ? engine.now() : Date.now();
  }

  const media = { at: -1e9, reduced: false, fine: false };

  function readMedia() {
    const now = perf();
    if (now - media.at < MEDIA_TTL_MS && now >= media.at) return media;
    media.at = now;
    media.reduced = reducedMotion(w);
    try {
      media.fine = Boolean(w.matchMedia && w.matchMedia('(hover: hover) and (pointer: fine)').matches);
    } catch {
      media.fine = false;
    }
    return media;
  }

  function still() {
    return readMedia().reduced || fxLevel() === 'static' || prefs.calm;
  }

  function slow() {
    return prefs.slow === null ? readMedia().reduced || prefs.calm : prefs.slow;
  }

  function up() {
    return cleanDir(prefs.dir) === 'up';
  }

  function keyboardy() {
    if (keysSeen) return true;
    return readMedia().fine;
  }

  function save() {
    writePrefs(store, prefs);
  }

  const clock = createSongClock({
    perf,
    hostNow,
    audio: () => (local.audioOn ? player.context() : null),
    outLat: () => player.outLat(),
    onShift: (zero) => {
      if (local.songOn) audio.resync(zero);
    },
  });
  clock.offset = prefs.tapOffset;

  const el = h('section', { class: 'game game-beatdrop', attrs: { 'aria-label': 'Beat Drop' } });
  const head = h('div', { class: 'beatdrop-headwrap' });
  const note = h('p', { class: 'beatdrop-note muted', attrs: { role: 'note' } });
  const cardBody = h('div', { class: 'bd-card-body' });
  const tutHost = h('div', { class: 'bd-tut-host' });
  const readyBox = h('div', { class: 'beatdrop-ready-card card glass' }, tutHost, cardBody);
  const hudScore = h('strong', { class: 'bd-score fx-num', text: '0' });
  const hudStreak = h('span', { class: 'bd-streak fx-num' });
  const hudStreakL = h('span', { class: 'bd-streak-l' });
  const hudFlame = h('span', { class: 'bd-flame', attrs: { 'aria-hidden': 'true' } });
  const hudPip = h('span', { class: 'bd-pip', attrs: { title: 'Full streak still alive', 'aria-hidden': 'true' } });
  const hudAcc = h('span', { class: 'bd-acc fx-num', text: '100%' });
  const liteChip = h('span', { class: 'bd-lite', text: 'lite' });
  const musicBtn = h('button', { class: 'bd-tg', type: 'button', dataset: { key: 'bd-music' }, text: 'Music' });
  const hud = h(
    'div',
    { class: 'bd-hud' },
    h('span', { class: 'bd-hud-l' }, hudScore, h('span', { class: 'bd-max', text: '/1000' })),
    h('span', { class: 'bd-hud-c' }, hudFlame, hudStreak, hudStreakL, hudPip),
    h('span', { class: 'bd-hud-r' }, hudAcc, liteChip, musicBtn),
  );
  const lostEl = h('p', { class: 'bd-lost', attrs: { 'aria-hidden': 'true' } });
  const banner = h('p', { class: 'bd-banner', attrs: { 'aria-hidden': 'true' } });
  const ticker = h('p', { class: 'bd-ticker' });
  const canvas = h('canvas', { class: 'bd-canvas', attrs: { role: 'application', 'aria-label': 'Beat Drop lanes. Use the lane keys or tap a lane.' } });
  const audioChip = h('button', { class: 'bd-audio', type: 'button', dataset: { key: 'bd-audio' }, text: 'Tap to turn on sound' });
  const specText = h('span', { class: 'bd-spec-text' });
  const specBox = h('div', { class: 'bd-spec' }, specText, button('How to play', { variant: 'ghost', size: 'sm', key: 'bd-spec-how', on: () => openTut('full', specBox) }));
  const wrap = h('div', { class: 'bd-wrap' }, canvas, audioChip, specBox);
  const side = h('ol', { class: 'bd-side', attrs: { 'aria-label': 'Live scores' } });
  const main = h('div', { class: 'bd-main' }, wrap, side);
  const padRow = h('div', { class: 'bd-pads' });
  const sr = h('span', { class: 'bd-sr', attrs: { 'aria-live': 'polite', role: 'status' } });
  const safeEl = h('div', { class: 'bd-safe', attrs: { 'aria-hidden': 'true' } });
  const stage = h('div', { class: 'bd-stage' }, hud, lostEl, banner, ticker, main, padRow, safeEl, sr);
  const resultsBox = h('div', { class: 'bd-results' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  show(audioChip, false);
  show(specBox, false);
  show(liteChip, false);
  el.append(head, note, readyBox, stage, resultsBox, foot);
  placePads();
  const draw = createBeatDraw(canvas, { doc: d });
  let pads = [];
  let canvasW = 0;
  let canvasH = 0;
  let sizeDirty = true;
  let wideNow = false;
  let topPx = '';
  let resized = false;
  const ro = typeof w.ResizeObserver === 'function' ? new w.ResizeObserver(() => {
    sizeDirty = true;
  }) : null;
  if (ro) ro.observe(canvas);

  function announce(text) {
    sr.textContent = text;
  }

  function paintToggles() {
    musicBtn.setAttribute('aria-pressed', prefs.music ? 'true' : 'false');
    musicBtn.classList.toggle('is-on', prefs.music);
    player.setMix({ music: prefs.music });
  }

  musicBtn.addEventListener('click', () => {
    prefs.music = !prefs.music;
    save();
    paintToggles();
  });
  paintToggles();

  function labels() {
    return keyboardy() ? keyLabels(prefs.keys) : null;
  }

  function buildPads() {
    const pal = laneStyle();
    const labs = keyLabels(prefs.keys);
    holdSig = '';
    pads = pal.map((pi, i) => {
      const pad = h(
        'button',
        { class: ['bd-pad', `bd-l${pi}`], type: 'button', dataset: { key: `bd-lane-${i}` }, attrs: { 'aria-label': `Lane ${i + 1} (${labs[i]})` } },
        h('span', { class: 'bd-pad-key', text: labs[i] }),
        h('span', { class: ['bd-sh', `bd-sh-${pi}`], attrs: { 'aria-hidden': 'true' } }),
      );
      pad.addEventListener('pointerdown', (e) => {
        if (e && typeof e.button === 'number' && e.button !== 0) return;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        pad.classList.add('is-down');
        press(i, e && e.timeStamp);
      });
      pad.addEventListener('click', (e) => {
        if (!e || e.detail !== 0) return;
        press(i, e.timeStamp);
      });
      const up = (e) => {
        const was = pad.classList.contains('is-down');
        pad.classList.remove('is-down');
        if (was) releaseLane(i, e && e.timeStamp);
      };
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointerleave', up);
      pad.addEventListener('pointercancel', up);
      return pad;
    });
    padRow.replaceChildren(...pads);
    stage.classList.toggle('bd-keys', keyboardy());
    placePads();
  }

  function placePads() {
    const isUp = up();
    stage.classList.toggle('bd-up', isUp);
    padRow.classList.toggle('bd-pads-top', isUp);
    padRow.classList.toggle('bd-pads-bottom', !isUp);
    if (padRow.parentNode === stage) stage.insertBefore(padRow, isUp ? main : safeEl);
  }

  function ensureAudio() {
    const s = player.ensure();
    if (s === 'blocked' || s === 'ok') local.audioWant = true;
    return s;
  }

  function startAudio() {
    if (!local.song || local.audioOn || !model || model.phase !== 'play') return false;
    if (player.status() !== 'ok') return false;
    local.audioOn = true;
    const zero = clock.mapAudio();
    if (zero === null) {
      local.audioOn = false;
      return false;
    }
    player.setMix({ music: prefs.music });
    if (clock.songT() > local.song.dur) return true;
    startSong(zero);
    show(audioChip, false);
    return true;
  }

  function startSong(zero) {
    if (local.songOn || !local.song || zero === null) return false;
    const span = songSpan(local.song);
    if (!span) return false;
    const entry = audio.ready(span.url, span.from, span.len);
    if (!entry) return false;
    local.songOn = audio.play({ ctx: player.context(), out: player.bus(), entry, zero, len: span.len });
    return local.songOn;
  }

  function stopSong() {
    audio.stop();
    local.songOn = false;
  }

  function fetchSong(m) {
    const n = m.n;
    load.n = n;
    load.state = 'wait';
    load.pct = 0;
    load.try += 1;
    const attempt = load.try;
    let settled = false;
    const finish = (ok) => {
      if (settled || gone || load.n !== n || load.try !== attempt) return;
      settled = true;
      if (typeof w.clearTimeout === 'function') w.clearTimeout(timerId);
      load.state = ok ? 'ok' : 'fail';
      load.pct = ok ? 1 : load.pct;
      if (model && model.n === n && model.phase === 'ready' && model.playing) engine.act({ type: ok ? 'loaded' : 'nolo', n });
      repaintReady();
      if (ok && model && model.n === n && model.phase === 'play') {
        freshRun();
        if (local.audioOn) startSong(clock.zero);
      }
    };
    const began = perf();
    let moved = began;
    let timerId = null;
    const arm = () => {
      if (typeof w.setTimeout !== 'function') return;
      timerId = w.setTimeout(() => {
        const now = perf();
        if (!settled && now - moved < LOAD_MS && now - began < LOAD_MAX_MS) return arm();
        finish(false);
      }, LOAD_MS);
    };
    arm();
    loadChart(m.sid, m.cv)
      .then(() => {
        const song = chartSong(m.sid, m.cv, m.df, m.len);
        const span = songSpan(song);
        if (!span) throw new Error('The song did not load.');
        return audio.load(span.url, {
          from: span.from,
          len: span.len,
          onProgress: (p) => {
            const next = Math.round(Math.max(0, Math.min(1, p)) * 20) / 20;
            if (next === load.pct || load.n !== n) return;
            moved = perf();
            load.pct = next;
            repaintReady();
          },
        });
      })
      .then(() => finish(true), () => finish(false));
  }

  function wantSong(m) {
    if (!m || !m.sid || (m.phase !== 'ready' && m.phase !== 'play')) return;
    if (load.n === m.n) return;
    fetchSong(m);
  }

  function layout(force = false) {
    if (!model || model.phase !== 'play') return;
    const wide = (stage.clientWidth || 0) > WIDE_PX;
    wideNow = wide;
    sizeDirty = true;
    stage.classList.toggle('bd-wide', wide);
    const bar = d && typeof d.querySelector === 'function' ? d.querySelector('.top') : null;
    const r0 = bar && typeof bar.getBoundingClientRect === 'function' ? bar.getBoundingClientRect() : null;
    const head = r0 && r0.height > 0 && r0.height < 160 ? Math.round(r0.height) : 0;
    if (topPx !== `${head + 8}px`) {
      topPx = `${head + 8}px`;
      stage.style.setProperty('--bd-top', topPx);
    }
    if (layoutN !== model.n) {
      layoutN = model.n;
      const behavior = still() ? 'auto' : 'smooth';
      try {
        if (typeof stage.scrollIntoView === 'function') stage.scrollIntoView({ block: 'start', behavior });
      } catch {
        layoutN = model.n;
      }
    }
    let top = head + 8;
    if (still() && typeof stage.getBoundingClientRect === 'function') {
      const r = stage.getBoundingClientRect();
      top = r && Number.isFinite(r.top) ? Math.max(head + 8, Math.min(240, r.top)) : top;
    }
    const padsOn = !stage.classList.contains('bd-keys');
    const ht = heightFor(w.innerHeight, top, wide, padsOn);
    const wd = widthFor(LANES);
    const sig = `${ht}|${wd}|${wide}|${padsOn}`;
    if (!force && sig === layoutSig) return;
    const moved = resized || (layoutSig !== '' && sig !== layoutSig);
    resized = false;
    layoutSig = sig;
    if (moved && typeof stage.getBoundingClientRect === 'function') {
      const r = stage.getBoundingClientRect();
      if (r && Number.isFinite(r.top) && Math.abs(r.top - (head + 8)) > 2) {
        try {
          if (typeof stage.scrollIntoView === 'function') stage.scrollIntoView({ block: 'start', behavior: 'auto' });
        } catch {
          layoutSig = sig;
        }
      }
    }
    stage.style.setProperty('--bd-h', `${ht}px`);
    stage.style.setProperty('--bd-w', `${wd}px`);
  }

  function freshRun() {
    if (!model || model.phase !== 'play' || local.n === model.n) return;
    const song = beatdrop.songOf(snap);
    if (!song) {
      if (model.sid) {
        const n = model.n;
        loadChart(model.sid, model.cv).then(() => {
          if (!gone && model && model.n === n && snap) update(snap);
        }, () => null);
        wantSong(model);
      }
      return;
    }
    stopSong();
    local.n = model.n;
    local.song = song;
    local.lanes = LANES;
    local.look = lookFor(model.df, slow()) / cleanSpeed(prefs.speed);
    local.judge = model.playing ? createJudge(song, model.df) : null;
    local.demo = !model.playing;
    local.mark = local.judge ? local.judge.mark : new Uint8Array(song.notes.length);
    local.tail = local.judge ? local.judge.tail : null;
    local.sent = false;
    local.lastProg = perf();
    local.marks = sectionMarks(song);
    local.drops = local.marks.filter((m) => m.sec === 'drop').map((m) => m.t);
    local.pressAt.fill(-1e9);
    local.missAt.fill(-1e9);
    local.down = [false, false, false, false];
    local.flash = [null, null, null, null];
    local.judgeFx = [null, null, null, null];
    local.count = null;
    local.audioOn = false;
    local.hiddenMs = 0;
    local.hiddenAt = null;
    local.frames = [];
    local.spanStart = perf();
    local.announced = false;
    local.demoAt = 0;
    sizeDirty = true;
    lite = fxLevel() === 'lite';
    show(liteChip, lite);
    canvasSig = '';
    rivalGap = null;
    lastEv = Math.max(0, ...model.ev.map((e) => e[3] || 0));
    fixInfo = null;
    bestInfo = null;
    clock.reset(model.at);
    clock.offset = prefs.tapOffset;
    buildPads();
    stage.classList.add('bd-live');
    layout(true);
    wantSong(model);
    const s = ensureAudio();
    if (!startAudio()) show(audioChip, s === 'blocked');
  }

  function releaseLane(lane, ts) {
    if (gone || !model || model.phase !== 'play' || !local.judge || local.sent) return false;
    if (!(local.judge.holding[lane] >= 0)) return false;
    const now = perf();
    const t = clock.judgeT(eventTime(ts, now));
    handle(local.judge.release(lane, t * 1000), now);
    paintHud();
    return true;
  }

  function paintHolds() {
    const hs = local.judge ? local.judge.holding : null;
    const sig = hs ? hs.map((x) => (x >= 0 ? 1 : 0)).join('') : '';
    if (sig === holdSig) return;
    holdSig = sig;
    pads.forEach((pad, i) => pad.classList.toggle('is-hold', Boolean(hs && hs[i] >= 0)));
  }

  function sendProg(now) {
    const j = local.judge;
    if (!j || local.sent) return;
    local.lastProg = now;
    engine.act({ type: 'prog', n: local.n, v: j.prog() });
  }

  function sendDone() {
    const j = local.judge;
    if (!j || local.sent) return;
    local.sent = true;
    engine.act({ type: 'done', n: local.n, v: j.final() });
    announce(`Song over, you scored ${j.score}`);
    cue.play(j.full ? 'correct' : 'send');
    paintSpec();
  }

  function showBanner(text, bad = false) {
    banner.textContent = text;
    banner.classList.toggle('is-bad', bad);
    banner.classList.add('is-on');
    local.bannerAt = perf();
  }

  function handle(evs, now) {
    for (const ev of evs) {
      if (ev.k === 'm') {
        local.missAt[ev.lane] = now;
        local.judgeFx[ev.lane] = { k: 'm', at: now, tag: '' };
        local.shakeAt = now;
        if (ev.lost >= LOST_MIN) {
          lostEl.textContent = `Streak lost (${ev.lost})`;
          lostEl.classList.add('is-on');
          local.lostAt = now;
          player.duck();
        }
        continue;
      }
      if (ev.k === 'x') {
        if (ev.reset) {
          showBanner('Too many extra taps - streak reset', true);
          if (ev.lost >= LOST_MIN) {
            lostEl.textContent = `Streak lost (${ev.lost})`;
            lostEl.classList.add('is-on');
            local.lostAt = now;
          }
        }
        continue;
      }
      const a = Math.abs(ev.dt);
      local.flash[ev.lane] = { k: ev.k, at: now };
      local.judgeFx[ev.lane] = { k: ev.k, at: now, tag: ev.k !== 'p' && a > 30 ? (ev.dt < 0 ? 'early' : 'late') : '' };
      draw.burst(ev.lane, now, still() ? 0 : lite ? 3 : 6);
      if (ev.up) {
        showBanner(`${TIERS[ev.up - 1]} streak!`);
      }
    }
  }

  function press(lane, ts) {
    if (gone || !model) return false;
    if (tut && !tut.gone) return tut.press(lane, eventTime(ts, perf()));
    if (model.phase !== 'play') return false;
    freshRun();
    if (!local.song) return false;
    if (!local.audioOn) ensureAudio();
    const now = perf();
    if (lane >= 0 && lane < 4) local.pressAt[lane] = now;
    if (!local.judge || local.sent) return false;
    const t = clock.judgeT(eventTime(ts, now));
    if (t < -1) return false;
    handle(local.judge.press(lane, t * 1000), now);
    paintHud();
    return true;
  }

  let hudSig = '';
  function paintHud() {
    const j = local.judge;
    const s = j ? j.stats : { p: 0, g: 0, o: 0, m: 0, j: 0, c: 0, b: 0 };
    const n = countOf(local.song);
    const score = scoreOf(s.p, s.g, s.o, s.b, n);
    const acc = s.j ? Math.round(accOf(s.p, s.g, s.o, s.j) * 100) : 100;
    const tier = tierOf(s.c);
    const pip = Boolean(j) && s.m === 0 && s.c >= 2;
    const sig = `${score}|${s.c}|${acc}|${tier}|${pip}`;
    if (sig === hudSig) return;
    hudSig = sig;
    hudScore.textContent = String(score);
    hudStreak.textContent = s.c >= 2 ? String(s.c) : '';
    hudStreakL.textContent = s.c >= 2 ? 'streak' : local.demo ? 'Watching' : '';
    hudStreak.classList.toggle('is-big', s.c >= 5);
    hudFlame.textContent = tier ? '🔥' : '';
    hudFlame.dataset.tier = String(tier);
    hudPip.classList.toggle('is-on', pip);
    hudAcc.textContent = `${acc}%`;
  }

  function myScore() {
    const j = local.judge;
    if (!j || !local.song) return 0;
    return j.score;
  }

  function nameOfSlot(slot) {
    const r = model ? model.board.find((b) => b.slot === slot) : null;
    return r ? r.name : 'Someone';
  }

  function paintTicker(now) {
    if (!model) return;
    const ev = model.ev.filter((e) => e[3] > lastEv).pop();
    if (ev && now - toastAt >= TOAST_GAP_MS) {
      lastEv = ev[3];
      const mine = snap && ev[0] === snap.meSlot;
      if (!mine) {
        toastAt = now;
        toastUntil = now + TOAST_MS;
        ticker.textContent = evText(ev, nameOfSlot);
        ticker.className = 'bd-ticker is-toast';
        return;
      }
    }
    if (now < toastUntil) return;
    if (local.demo) {
      const lead = model.board[0];
      ticker.textContent = lead ? `${lead.name} leads with ${lead.score}` : 'Watching';
      ticker.className = 'bd-ticker';
      return;
    }
    const r = rivalLine(model.board, snap ? snap.meSlot : null, myScore());
    let cls = 'bd-ticker';
    if (rivalGap !== null && r.gap !== rivalGap) cls += (r.rank === 1 ? r.gap > rivalGap : r.gap < rivalGap) ? ' is-closing' : ' is-growing';
    rivalGap = r.gap;
    ticker.textContent = r.text;
    ticker.className = cls;
  }

  function paintSide() {
    if (!model) return;
    const mine = snap ? snap.meSlot : null;
    const rows = model.board.map((b) => (b.slot === mine && local.judge ? { ...b, score: myScore(), streak: local.judge.stats.c, tier: tierOf(local.judge.stats.c), pct: countOf(local.song) ? Math.round((local.judge.stats.j / countOf(local.song)) * 100) : 0 } : b));
    rows.sort((a, b) => b.score - a.score || a.slot - b.slot);
    const keep = new Set();
    rows.forEach((r, i) => {
      keep.add(r.slot);
      let row = sideRows.get(r.slot);
      if (!row) {
        const ini = h('span', { class: 'bd-side-ini', text: (r.initials || r.name || '?').slice(0, 2) });
        const nm = h('span', { class: 'bd-side-name', text: r.isMe ? 'You' : r.name });
        const sc = h('span', { class: 'bd-side-score fx-num' });
        const fl = h('span', { class: 'bd-side-flame', attrs: { 'aria-hidden': 'true' } });
        const stk = h('span', { class: 'bd-side-streak fx-num' });
        const bar = h('span', { class: 'bd-side-bar', attrs: { 'aria-hidden': 'true' } });
        row = { el: h('li', { class: ['bd-side-row', r.isMe ? 'is-me' : null] }, ini, nm, fl, stk, sc, bar), sc, fl, stk };
        row.el.style.setProperty('--bd-hue', String(Number(r.hue) || 0));
        sideRows.set(r.slot, row);
        side.append(row.el);
      }
      const pct = (Math.max(0, Math.min(100, r.pct)) / 100).toFixed(3);
      const sig = `${i}|${pct}|${r.score}|${r.tier ? 1 : 0}|${r.streak}|${r.done ? 1 : 0}`;
      if (row.sig === sig) return;
      row.sig = sig;
      row.el.style.setProperty('--bd-r', String(i));
      row.el.style.setProperty('--bd-pct', pct);
      row.sc.textContent = String(r.score);
      row.fl.textContent = r.tier ? '🔥' : '';
      row.stk.textContent = r.streak >= 2 ? `x${r.streak}` : '';
      row.el.classList.toggle('is-done', Boolean(r.done));
    });
    for (const [slot, row] of sideRows) {
      if (keep.has(slot)) continue;
      row.el.remove();
      sideRows.delete(slot);
    }
    if (side.dataset.n !== String(rows.length)) {
      side.dataset.n = String(rows.length);
      side.style.setProperty('--bd-n', String(rows.length));
    }
  }

  function paintSpec() {
    if (!model || model.phase !== 'play') return;
    const watching = local.demo;
    show(specBox, watching);
    stage.classList.toggle('bd-demo', watching);
    if (!watching) return;
    if (model.noLoad && load.n === model.n && load.state === 'ok') specText.textContent = model.last ? LATE_LOAD_LAST : LATE_LOAD_TEXT;
    else if (model.noLoad) specText.textContent = model.last ? "That song wouldn't load for you. Watching this one." : LOAD_FAIL_TEXT;
    else specText.textContent = model.last ? 'Watching - game ends after this song' : "Watching - you're in next song";
  }

  function frame(ts, dtFrame) {
    if (gone || !model || model.phase !== 'play' || !local.song) {
      looping = false;
      return false;
    }
    if (sizeDirty || !ro) {
      sizeDirty = false;
      canvasW = canvas.clientWidth || 0;
      canvasH = canvas.clientHeight || 0;
    }
    const now = perf();
    const song = local.song;
    const sT = clock.songT();
    const dropSoon = local.drops.some((t) => sT >= t - DROP_HOLD_S && sT < t);
    clock.step({ hold: dropSoon });
    if (local.audioWant && !local.audioOn && player.status() === 'ok') startAudio();
    if (local.audioOn && !local.songOn && sT < song.dur - 1) startSong(clock.zero);
    if (Number.isFinite(dtFrame) && !lite) {
      local.frames.push(dtFrame);
      if (now - local.spanStart >= LITE_SPAN_MS) {
        const avg = local.frames.reduce((a, b) => a + b, 0) / Math.max(1, local.frames.length);
        local.frames = [];
        local.spanStart = now;
        if (avg > LITE_MS && sT > 0) {
          lite = true;
          canvasSig = '';
          show(liteChip, true);
        }
      }
    }
    const t = clock.gameT();
    if (local.judge && !local.sent) {
      handle(local.judge.sweep(t * 1000 - MISS_GRACE_MS), now);
      if (now - local.lastProg >= PROG_MS && sT > 0) sendProg(now);
      if (t > lastNoteAt(song) + local.judge.win.o / 1000 + 0.25) {
        handle(local.judge.sweep(t * 1000 + 1e7), now);
        sendDone();
      }
    }
    if (local.demo && local.mark) {
      const notes = song.notes;
      for (; local.demoAt < notes.length && notes[local.demoAt].t <= t * 1000; local.demoAt += 1) {
        const i = local.demoAt;
        if (local.mark[i]) continue;
        local.mark[i] = 5;
        local.flash[notes[i].l] = { k: 'g', at: now };
      }
    }
    let count = null;
    if (sT < 0 && sT >= -3) count = String(Math.ceil(-sT - 1e-9));
    else if (sT >= 0 && sT < 0.5) count = 'GO!';
    if (count !== local.count) {
      local.count = count;
      if (count) announce(count === 'GO!' ? 'Song started' : count);
    }
    const wd = canvasW;
    const ht = canvasH;
    const ratio = lite ? 1 : Math.min(2, Number(w.devicePixelRatio) || 1);
    const isUp = up();
    const sig = `${wd}x${ht}x${ratio}x${isUp}`;
    if (wd > 0 && ht > 0 && sig !== canvasSig && draw.resize({ width: wd, height: ht, dpr: ratio, lanes: LANES, up: isUp })) canvasSig = sig;
    const j = local.judge;
    paintHolds();
    draw.draw({
      now,
      t,
      look: local.look,
      song,
      mark: local.mark,
      hold: local.tail,
      pressAt: local.pressAt,
      down: local.down,
      missAt: local.missAt,
      flash: local.flash,
      judge: local.judgeFx,
      labels: labels(),
      still: still(),
      lite,
      tier: j ? tierOf(j.stats.c) : 0,
      shake: fxLevel() === 'full',
      shakeAt: local.shakeAt,
      countdown: count,
      dropSoon,
      marks: local.marks,
      flatPulse: !local.audioOn,
    });
    if (now - local.lostAt > LOST_MS) lostEl.classList.remove('is-on');
    if (now - local.bannerAt > BANNER_MS) banner.classList.remove('is-on');
    paintHud();
    if (now - liveAt > 250) {
      liveAt = now;
      paintTicker(now);
      if (wideNow) paintSide();
    }
    if (sT > song.dur + 1.5 && (local.sent || !local.judge)) {
      looping = false;
      return false;
    }
    return true;
  }

  function tick(ts, dt) {
    try {
      return frame(ts, dt);
    } catch {
      looping = false;
      return false;
    }
  }

  function startLoop() {
    if (looping || gone) return;
    looping = true;
    loop.add(tick);
  }

  function closeTut() {
    if (tut && !tut.gone) tut.destroy();
    tut = null;
    tutHost.replaceChildren();
    for (const c of [...specBox.children]) if (c.classList && c.classList.contains('bd-tut')) c.remove();
  }

  function openTut(mode, host = tutHost) {
    closeTut();
    tut = createTutorial({
      perf,
      loop,
      synth: player,
      still,
      labels: () => (keyboardy() ? keyLabels(prefs.keys) : null),
      touch: () => !keyboardy(),
      offset: () => prefs.tapOffset,
      onOffset: (ms) => {
        prefs.tapOffset = clampOffset(ms);
        clock.offset = prefs.tapOffset;
        save();
      },
      onDone: ({ skipped }) => {
        prefs.seen = true;
        save();
        tut = null;
        tutHost.replaceChildren();
        for (const c of [...specBox.children]) if (c.classList && c.classList.contains('bd-tut')) c.remove();
        if (!skipped && mode === 'full') sendReady(model);
        repaintReady();
      },
      mode,
      up,
      doc: d,
    });
    host.append(tut.el);
    ensureAudio();
    if (model && model.phase === 'ready' && !model.watching && !model.iReady) engine.act({ type: 'learn', n: model.n });
    repaintReady();
    try {
      if (typeof tut.el.scrollIntoView === 'function') tut.el.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
    } catch {
      return tut;
    }
    return tut;
  }

  function onKey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (typing(t) || inDialog(t)) return;
    if (binding) return;
    const lane = laneOfKey(e, prefs.keys);
    if (lane < 0) return;
    const code = keyCodeOf(e);
    const active = tut && !tut.gone;
    const playing = model && model.phase === 'play';
    if (!active && !playing) return;
    if (!keysSeen) {
      keysSeen = true;
      stage.classList.add('bd-keys');
      layout();
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (e.repeat || held.has(code)) return;
    held.add(code);
    if (active) {
      tut.press(lane, eventTime(e.timeStamp, perf()));
      return;
    }
    if (!local.audioOn) ensureAudio();
    local.down[lane] = true;
    if (pads[lane]) pads[lane].classList.add('is-down');
    press(lane, e.timeStamp);
  }

  function onKeyUp(e) {
    const code = keyCodeOf(e);
    held.delete(code);
    const lane = laneOfKey(e, prefs.keys);
    if (lane < 0) return;
    if (bindsFor(prefs.keys)[lane].some((k) => held.has(k))) return;
    local.down[lane] = false;
    if (pads[lane]) pads[lane].classList.remove('is-down');
    releaseLane(lane, e && e.timeStamp);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!e || (typeof e.button === 'number' && e.button !== 0)) return;
    const wd = canvas.clientWidth || 0;
    const x = Number.isFinite(e.offsetX) ? e.offsetX : NaN;
    if (!(wd > 0) || !Number.isFinite(x)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const lane = Math.max(0, Math.min(local.lanes - 1, Math.floor((x / wd) * local.lanes)));
    pointers.set(e.pointerId, lane);
    local.down[lane] = true;
    press(lane, e.timeStamp);
  });
  const release = (e) => {
    if (!e || !pointers.has(e.pointerId)) return;
    const lane = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if ([...pointers.values()].includes(lane)) return;
    local.down[lane] = false;
    releaseLane(lane, e.timeStamp);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);
  const unlockAudio = () => {
    if (model && model.phase === 'play' && !local.audioOn) ensureAudio();
  };
  stage.addEventListener('pointerdown', unlockAudio);
  stage.addEventListener('pointerup', unlockAudio);
  stage.addEventListener('click', unlockAudio);
  audioChip.addEventListener('click', () => {
    ensureAudio();
    startAudio();
  });

  const keyTarget = d && typeof d.addEventListener === 'function' ? d : null;
  function letGo() {
    held.clear();
    pointers.clear();
    local.down = [false, false, false, false];
    for (const pad of pads) pad.classList.remove('is-down');
    for (let l = 0; l < LANES; l += 1) releaseLane(l);
  }

  function onVisible() {
    if (!d) return;
    const hidden = d.hidden === true || d.visibilityState === 'hidden';
    if (hidden) {
      letGo();
      local.hiddenAt = perf();
      player.mute(true);
      stopSong();
      return;
    }
    player.mute(false);
    if (local.hiddenAt === null) return;
    const away = perf() - local.hiddenAt;
    local.hiddenAt = null;
    if (!model || model.phase !== 'play' || !local.song) return;
    local.hiddenMs += away;
    clock.reanchor();
    if (away > 1000 && local.judge && !local.sent) showBanner('You were away - notes kept falling', true);
    if (local.judge && !local.sent && local.hiddenMs > local.song.dur * 500) {
      handle(local.judge.sweep(clock.gameT() * 1000), perf());
      sendDone();
    }
    if (looping) loop.add(tick);
  }
  if (keyTarget) {
    keyTarget.addEventListener('keydown', onBindKey, true);
    keyTarget.addEventListener('keydown', onKey);
    keyTarget.addEventListener('keyup', onKeyUp);
    keyTarget.addEventListener('visibilitychange', onVisible);
  }
  const onResize = () => {
    resized = true;
    layoutSig = '';
    layout();
  };
  if (typeof w.addEventListener === 'function') {
    w.addEventListener('resize', onResize);
    w.addEventListener('blur', letGo);
  }
  const sfxOff = player.sfx && typeof player.sfx.on === 'function' ? player.sfx.on('change', () => paintNote()) : null;

  function paintNote() {
    const text = model && model.phase !== 'show' ? soundNote(player.status()) : null;
    note.textContent = text || '';
    note.classList.toggle('is-empty', !text);
  }

  function sendReady(m) {
    if (!m || m.phase !== 'ready' || m.iReady || m.watching) return;
    ensureAudio();
    cue.play('send');
    engine.act({ type: 'ready', n: m.n });
  }

  function readyModel(m) {
    if (!m || m.phase !== 'ready') return null;
    const mine = load.n === m.n && load.state !== 'idle' ? load.state : m.loading ? m.loading.mine : 'wait';
    return { n: m.n, number: m.number, total: m.total, track: m.track, song: m.song, faster: m.faster, diffName: m.diffName, len: m.len, notes: m.notes, iReady: m.iReady, watching: m.watching, dots: m.dots, starts: m.starts, ends: m.ends, slow: slow(), calm: prefs.calm, speed: cleanSpeed(prefs.speed), keys: keyLabels(prefs.keys), custom: Boolean(cleanKeys(prefs.keys)), binding: binding ? binding.got.length : null, bound: binding ? binding.got.map(keyName) : [], offset: prefs.tapOffset, dir: cleanDir(prefs.dir), panel: prefs.panel !== false, tut: Boolean(tut), load: { mine, pct: mine === 'ok' ? 1 : load.n === m.n ? load.pct : 0, done: m.loading ? m.loading.done : 0, of: m.loading ? m.loading.of : 0 } };
  }

  function retryLoad() {
    if (!model || model.phase !== 'ready' || !model.sid) return;
    fetchSong(model);
    repaintReady();
  }

  function loadBox(r) {
    if (!r.load) return null;
    const ld = r.load;
    return h(
      'div',
      { class: ['bd-load-box', `is-${ld.mine}`], attrs: { role: 'status', 'aria-live': 'polite' } },
      h('div', { class: 'bd-load', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ld.pct * 100)), 'aria-label': 'Song loading' } }, h('span', { class: 'bd-load-fill', vars: { '--bd-load': ld.pct.toFixed(2) } })),
      h('p', { class: 'bd-load-text muted', text: `${loadText(ld.mine)} ${ld.done} of ${ld.of} loaded.` }),
      ld.mine === 'fail' ? button('Try again', { variant: 'ghost', size: 'sm', key: 'bd-load-retry', on: retryLoad }) : null,
    );
  }

  const paintReady = memo((r) => {
    if (!r) return null;
    const icons = laneStyle().map((pi) => SHAPE_ICON[pi]).join(' ');
    return h(
      'div',
      { class: 'bd-ready' },
      h('p', { class: 'bd-upnum', text: `Song ${r.number} of ${r.total} - NEXT UP` }),
      h('h2', { class: 'question beatdrop-title fx-display' }, `Song: ${songLine(r.song)}`, adultTag(r.song)),
      r.song.credit ? h('p', { class: 'bd-credit muted', text: `Credit: ${r.song.credit}` }) : null,
      h('p', { class: 'bd-goal', text: GOAL }),
      h(
        'ul',
        { class: 'beatdrop-facts' },
        r.track.bpm ? h('li', { text: `${r.track.bpm} BPM` }) : null,
        r.faster ? h('li', { class: 'is-faster', text: 'Faster!' }) : null,
        h('li', { text: r.diffName }),
        h('li', { text: `4 lanes ${icons}` }),
        h('li', { text: lengthLabel(r.len) }),
        r.notes ? h('li', { text: `${r.notes} notes` }) : null,
      ),
      loadBox(r),
      h('p', { class: 'bd-scoreline muted', text: SCORE_LINE }),
      h(
        'div',
        { class: 'beatdrop-ready-actions bd-go' },
        r.watching ? null : button(r.iReady ? 'Ready!' : "I'm ready", { variant: 'primary', size: 'lg', key: 'bd-ready', disabled: r.iReady, on: () => sendReady(model) }),
        r.tut ? null : button('How to play', { variant: 'secondary', size: 'lg', key: 'bd-how', on: () => openTut('full') }),
      ),
      timer(r.starts, r.ends, 'Song starts in'),
      r.dots.length ? h('div', { class: 'bd-dots', attrs: { 'aria-label': `${r.dots.filter((x) => x.on).length} of ${r.dots.length} ready` } }, r.dots.map((x) => h('span', { class: ['bd-dot', x.on ? 'is-on' : null, x.ld ? 'is-loaded' : null, x.lf ? 'is-fail' : null, x.isMe ? 'is-me' : null] }))) : null,
      settingsPanel(r),
    );
  });

  function settingsPanel(r) {
    const id = (s) => `${uid}-${s}`;
    const pal = laneStyle();
    const summary = `${speedLabel(r.speed)} - ${r.dir === 'up' ? 'Up' : 'Down'} - ${r.keys.join(' ')}`;
    const binding = r.binding !== null;
    const caps = h(
      'div',
      { class: ['bd-caps', binding ? 'is-binding' : null], attrs: { role: 'list', 'aria-label': `Lane keys: ${r.keys.join(', ')}` } },
      pal.map((pi, i) => {
        const setting = binding && i === r.binding;
        const done = binding && i < r.binding;
        const label = binding ? (done ? r.bound[i] : setting ? '?' : '') : r.keys[i];
        return h('span', { class: ['bd-cap', `bd-l${pi}`, setting ? 'is-set' : null, done ? 'is-done' : null], dataset: { key: `bd-cap-${i}` }, attrs: { role: 'listitem', 'aria-label': `Lane ${i + 1}: ${label || 'not set'}`, 'aria-current': setting ? 'true' : null } }, h('span', { class: ['bd-sh', `bd-sh-${pi}`], attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'bd-cap-key', text: label }));
      }),
    );
    const keysCtl = [
      caps,
      binding ? h('p', { class: 'bd-bind-msg', attrs: { role: 'status', 'aria-live': 'assertive' }, text: `Press the key for lane ${r.binding + 1} of 4. Esc cancels.` }) : null,
      h(
        'div',
        { class: 'bd-set-btns' },
        binding ? button('Cancel', { variant: 'secondary', size: 'sm', key: 'bd-keys-cancel', on: () => stopBinding() }) : button('Change keys', { variant: 'secondary', size: 'sm', key: 'bd-keys-change', on: () => startBinding() }),
        !binding && r.custom ? button('Reset to D F J K', { variant: 'secondary', size: 'sm', key: 'bd-keys-reset', on: () => resetKeys() }) : null,
      ),
    ];
    const body = h(
      'div',
      { class: 'bd-set-body', attrs: { id: id('set'), hidden: !r.panel } },
      setGroup(
        'Gameplay',
        setRow(
          id('speed'),
          'Scroll speed',
          'Higher spreads notes out',
          h(
            'div',
            { class: 'bd-seg bd-step', attrs: { role: 'group', 'aria-labelledby': id('speed') } },
            segBtn('−', false, 'bd-speed-down', () => changeSpeed(-1), { plain: true, label: 'Slower', disabled: r.speed <= SPEEDS[0] }),
            h('output', { class: 'bd-speed-value', text: speedLabel(r.speed), attrs: { 'aria-live': 'polite' } }),
            segBtn('+', false, 'bd-speed-up', () => changeSpeed(1), { plain: true, label: 'Faster', disabled: r.speed >= SPEEDS[SPEEDS.length - 1] }),
          ),
          h('span', { class: 'bd-spd-prev', vars: { '--bd-spd': String(r.speed) }, attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
        ),
        setRow(
          id('dir'),
          'Note direction',
          r.dir === 'up' ? 'Notes rise to the top line' : 'Notes fall to the bottom line',
          h('div', { class: 'bd-seg', attrs: { role: 'group', 'aria-labelledby': id('dir') } }, segBtn('Down', r.dir === 'down', 'bd-dir-down', () => changeDir('down')), segBtn('Up', r.dir === 'up', 'bd-dir-up', () => changeDir('up'))),
        ),
        setRow(id('slow'), 'Slower notes', 'More time to read each note', switchBtn(r.slow, 'bd-slow', id('slow'), () => toggleSlow())),
      ),
      setGroup(
        'Controls',
        h('div', { class: ['bd-set-row', 'bd-set-keys', 'bd-keybinds'] }, h('div', { class: 'bd-set-lab' }, h('span', { class: 'bd-set-name', text: 'Keys', attrs: { id: id('keys') } }), h('span', { class: 'bd-set-hint', text: 'One key per lane, left to right' })), h('div', { class: 'bd-set-ctl' }, ...keysCtl)),
        setRow(
          id('off'),
          'Timing',
          'Nudge if hits feel early or late',
          h(
            'div',
            { class: 'bd-seg bd-step', attrs: { role: 'group', 'aria-labelledby': id('off') } },
            segBtn('−', false, 'bd-off-down', () => nudge(-NUDGE_MS), { plain: true, label: `Earlier by ${NUDGE_MS} ms`, disabled: r.offset <= -TIMING_MAX }),
            h('output', { class: 'bd-offset', text: offsetLabel(r.offset), attrs: { 'aria-live': 'polite' } }),
            segBtn('+', false, 'bd-off-up', () => nudge(NUDGE_MS), { plain: true, label: `Later by ${NUDGE_MS} ms`, disabled: r.offset >= TIMING_MAX }),
          ),
          r.tut ? null : button('Re-check', { variant: 'secondary', size: 'sm', key: 'bd-timing', attrs: { 'aria-label': 'Re-check timing' }, on: () => openTut('timing') }),
        ),
      ),
      setGroup('Display', setRow(id('calm'), 'Calm view', 'Fewer effects and no shaking', switchBtn(r.calm, 'bd-calm', id('calm'), () => toggleCalm()))),
    );
    return h(
      'section',
      { class: ['bd-set', r.panel ? 'is-open' : 'is-closed'], attrs: { 'aria-labelledby': id('set-t') } },
      h(
        'button',
        { class: 'bd-set-head', type: 'button', dataset: { key: 'bd-set-toggle' }, attrs: { 'aria-expanded': r.panel ? 'true' : 'false', 'aria-controls': id('set') }, on: { click: () => togglePanel() } },
        h('span', { class: 'bd-set-title', text: 'Your settings', attrs: { id: id('set-t') } }),
        h('span', { class: 'bd-set-sum', text: summary }),
        h('span', { class: 'bd-set-chev', attrs: { 'aria-hidden': 'true' } }),
      ),
      body,
    );
  }

  function toggleSlow() {
    prefs.slow = !slow();
    save();
    if (model) local.look = lookFor(model.df, slow()) / cleanSpeed(prefs.speed);
    repaintReady();
  }

  function toggleCalm() {
    prefs.calm = !prefs.calm;
    save();
    repaintReady();
  }

  function togglePanel() {
    prefs.panel = prefs.panel === false;
    save();
    repaintReady();
  }

  function changeDir(dir) {
    const next = cleanDir(dir);
    if (prefs.dir === next) return;
    prefs.dir = next;
    save();
    canvasSig = '';
    placePads();
    repaintReady();
  }

  function nudge(ms) {
    prefs.tapOffset = clampOffset(prefs.tapOffset + ms);
    clock.offset = prefs.tapOffset;
    save();
    repaintReady();
  }

  function startBinding() {
    binding = { got: [] };
    repaintReady();
  }

  function stopBinding() {
    binding = null;
    repaintReady();
  }

  function resetKeys() {
    prefs.keys = null;
    save();
    refreshKeys();
  }

  function refreshKeys() {
    held.clear();
    if (typeof buildPads === 'function' && pads && pads.length) {
      const labs = keyLabels(prefs.keys);
      pads.forEach((pad, i) => {
        const tag = pad.querySelector ? pad.querySelector('.bd-pad-key') : null;
        if (tag) tag.textContent = labs[i];
        pad.setAttribute('aria-label', `Lane ${i + 1} (${labs[i]})`);
      });
    }
    repaintReady();
  }

  function onBindKey(e) {
    if (!binding || !e) return;
    const code = keyCodeOf(e);
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    if (code === 'Escape') return stopBinding();
    if (!okKey(code) || binding.got.includes(code)) return;
    binding.got.push(code);
    if (binding.got.length < LANES) return repaintReady();
    prefs.keys = binding.got.slice();
    binding = null;
    save();
    refreshKeys();
  }

  function changeSpeed(dir) {
    prefs.speed = stepSpeed(prefs.speed, dir);
    save();
    if (model) local.look = lookFor(model.df, slow()) / prefs.speed;
    repaintReady();
  }

  function repaintReady() {
    paintReady(cardBody, readyModel(model));
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: '🥁 Beat Drop' }),
      h('span', { class: 'game-count', text: `Song ${m.number} of ${m.total}` }),
      h('span', { class: 'beatdrop-tag', text: `${m.track.emoji} ${m.track.name} - ${m.diffName}` }),
      m.phase === 'show' ? timer(m.starts, m.ends, m.last ? 'Results in' : 'Next song in') : null,
    ),
  );

  function fixIt(ms) {
    prefs.tapOffset = clampOffset(prefs.tapOffset + ms);
    clock.offset = prefs.tapOffset;
    save();
    if (fixInfo) fixInfo = { ...fixInfo, fixed: true };
    paintResults(resultsBox, resultsModel(model));
  }

  function resultsModel(m) {
    if (!m || m.phase !== 'show') return null;
    const me = m.mine;
    return {
      n: m.n,
      me: me ? { grade: me.grade, score: me.score, p: me.p, g: me.g, o: me.o, m: me.m, best: me.best, acc: me.acc, flag: me.flag, fc: me.fc } : null,
      total: m.notes,
      fix: fixInfo,
      newBest: Boolean(bestInfo && bestInfo.isNew),
      song: m.sid ? m.song : null,
      skipped: m.skipped,
      rows: m.results.map((r) => ({ id: r.id, name: r.name, initials: r.initials, hue: r.hue, avatar: r.avatar, isMe: r.isMe, slot: r.slot, place: r.place, grade: r.grade, score: r.score, acc: r.acc, best: r.best, pts: r.pts, flag: r.flag, badges: r.badges })),
      sat: m.satOut.map((r) => (r.isMe ? 'You' : r.name)),
      next: m.next,
      last: m.last,
      starts: m.starts,
      ends: m.ends,
      admin: Boolean(engine.admin && typeof engine.admin.me === 'function' && engine.admin.me()),
    };
  }

  const paintResults = memo((r) => {
    if (!r) return null;
    const me = r.me;
    let card = null;
    if (me && me.flag !== FLAG_SAT) {
      const hits = me.p + me.g + me.o;
      const tot = Math.max(1, r.total);
      const bar = h('div', { class: 'bd-bar', attrs: { role: 'img', 'aria-label': `Perfect ${me.p}, Great ${me.g}, Good ${me.o}, Miss ${me.m}` } }, ['p', 'g', 'o', 'm'].map((k) => h('span', { class: `bd-bar-${k}` })));
      bar.style.setProperty('--bd-p', (me.p / tot).toFixed(4));
      bar.style.setProperty('--bd-g', (me.g / tot).toFixed(4));
      bar.style.setProperty('--bd-o', (me.o / tot).toFixed(4));
      bar.style.setProperty('--bd-m', (me.m / tot).toFixed(4));
      const fix = r.fix;
      card = h(
        'div',
        { class: ['bd-me', 'card', me.fc ? 'is-fc' : null] },
        h('div', { class: 'bd-me-top' }, h('span', { class: ['bd-big-grade', `grade-${String(me.grade).toLowerCase()}`], text: me.grade }), h('span', { class: 'bd-me-score fx-num', text: `${me.score} / 1000` }), r.newBest ? h('span', { class: 'bd-newbest', text: 'New best!' }) : null),
        h('p', { class: 'bd-me-line', text: `Hit ${hits}/${r.total} - best streak ${me.best} - ${me.acc}%` }),
        bar,
        h('p', { class: 'bd-counts muted', text: `Perfect ${me.p} - Great ${me.g} - Good ${me.o} - Miss ${me.m}` }),
        fix && fix.label
          ? h(
              'p',
              { class: 'bd-tend' },
              fix.fixed ? `Timing adjusted by ${fix.fix > 0 ? '+' : ''}${fix.fix} ms.` : fix.fix ? `You hit about ${Math.abs(fix.fix)} ms ${fix.fix > 0 ? 'late' : 'early'}. ` : `${fix.label}.`,
              fix.fix && !fix.fixed ? button('Fix it', { variant: 'ghost', size: 'sm', key: 'bd-fix', on: () => fixIt(fix.fix) }) : null,
            )
          : null,
      );
    } else if (me) card = h('div', { class: 'bd-me card' }, h('p', { class: 'bd-me-line', text: 'You sat this song out. Tap the notes next time to score!' }));
    const played = r.rows.filter((x) => x.flag !== FLAG_SAT);
    const songHead = r.song
      ? h('div', { class: 'bd-songhead' }, h('h3', { class: 'bd-songline' }, songLine(r.song), adultTag(r.song)), r.song.credit ? h('p', { class: 'bd-credit muted', text: `Credit: ${r.song.credit}` }) : null)
      : null;
    if (r.skipped) {
      return h(
        'div',
        { class: 'bd-res-wrap' },
        songHead,
        h('p', { class: 'bd-me-line bd-skip', attrs: { role: 'status' }, text: r.skipped }),
        r.next ? h('div', { class: 'bd-upnext' }, h('span', { text: `Up next: ${r.next.emoji} ${r.next.name} - ${r.next.diffName}` }), timer(r.starts, r.ends, 'Next song in')) : null,
        r.admin ? h('div', { class: 'beatdrop-ready-actions' }, button(r.last ? 'Finish' : 'Next', { variant: 'ghost', size: 'sm', key: 'bd-next', on: () => engine.admin.run({ type: 'skip' }) })) : null,
      );
    }
    return h(
      'div',
      { class: 'bd-res-wrap' },
      songHead,
      card,
      h(
        'ol',
        { class: 'bd-res' },
        played.map((x, i) =>
          h(
            'li',
            { class: ['bd-res-row', x.isMe ? 'is-me' : null, x.flag === FLAG_LEFT ? 'is-left' : null], vars: { '--i': i } },
            h('span', { class: 'bd-res-place', text: x.flag === FLAG_LEFT ? 'left' : MEDALS[x.place - 1] || String(x.place) }),
            profileButton(x, 'sm'),
            h('span', { class: 'bd-res-name', text: x.isMe ? 'You' : x.name }),
            h('span', { class: ['bd-grade', `grade-${String(x.grade).toLowerCase()}`], text: x.grade }),
            h('span', { class: 'bd-res-score fx-num', text: String(x.score) }),
            h('span', { class: ['bd-res-pts', x.pts ? null : 'is-zero'], text: x.pts ? `+${x.pts}` : '0' }),
            h('span', { class: 'bd-res-sub' }, h('span', { class: 'bd-res-stats muted', text: `${x.acc}% - streak ${x.best}` }), x.badges.map((b) => h('span', { class: 'bd-badge', text: b }))),
          ),
        ),
      ),
      r.sat.length ? h('p', { class: 'bd-sat muted', text: `Sat out: ${r.sat.join(', ')}` }) : null,
      r.next ? h('div', { class: 'bd-upnext' }, h('span', { text: `Up next: ${r.next.emoji} ${r.next.name}${r.next.bpm ? ` - ${r.next.bpm} BPM` : ''} - ${r.next.diffName}` }), timer(r.starts, r.ends, 'Next song in')) : null,
      r.admin ? h('div', { class: 'beatdrop-ready-actions' }, button(r.last ? 'Finish' : 'Next', { variant: 'ghost', size: 'sm', key: 'bd-next', on: () => engine.admin.run({ type: 'skip' }) })) : null,
    );
  });

  function onShow(m) {
    const j = local.judge;
    if (j && local.n === m.n) {
      fixInfo = { ...tendencyOf(j.dts), fixed: false };
      const me = m.mine;
      if (me && me.flag === 0) {
        const k = `${m.track.id}.${m.df}`;
        const prev = prefs.best[k];
        bestInfo = { isNew: prev === undefined ? me.score > 0 : me.score > prev };
        if (bestInfo.isNew) {
          prefs.best[k] = me.score;
          save();
        }
      }
    }
  }

  function update(next) {
    if (gone) return;
    snap = next;
    const m = next && (!next.room || next.room.phase === 'game') ? beatdrop.model(next) : null;
    model = m;
    if (!m) {
      stopSong();
      local.audioOn = false;
      paintReady(cardBody, null);
      show(readyBox, false);
      show(stage, false);
      show(resultsBox, false);
      return;
    }
    const beat = `${m.n}:${m.phase}`;
    const fresh = heard !== beat;
    const was = heard;
    heard = beat;
    if (fresh && m.phase === 'show') onShow(m);
    wantSong(m);
    paintHead(head, { number: m.number, total: m.total, track: m.track, diffName: m.diffName, phase: m.phase, starts: m.starts, ends: m.ends, last: m.last });
    el.dataset.phase = m.phase;
    repaintReady();
    show(readyBox, m.phase === 'ready');
    const playing = m.phase === 'play';
    show(stage, playing);
    show(resultsBox, m.phase === 'show');
    if (m.phase === 'ready' && !prefs.seen && !autoTried && !m.watching && !m.iReady) {
      autoTried = true;
      openTut('full');
    }
    if (playing) {
      if (tut && !tut.gone && (m.playing || tut.el.parentNode !== specBox)) closeTut();
      freshRun();
      paintSpec();
      layout();
      startLoop();
      liveAt = 0;
    } else {
      stage.classList.remove('bd-live');
      stopSong();
      local.audioOn = false;
      if (m.phase === 'show' && tut && tut.el.parentNode === specBox) closeTut();
    }
    paintResults(resultsBox, resultsModel(m));
    foot.textContent = footText(m);
    paintNote();
    if (fresh && was) {
      if (m.phase === 'show') {
        cue.play('reveal');
        const rows = resultsBox.querySelector('.bd-res');
        if (rows && !still()) rows.classList.add('fx-stagger');
        const lvl = fxLevel();
        if (m.mine && m.mine.place === 1 && m.results.length > 1 && fx && typeof fx.confetti === 'function' && !still() && lvl !== 'static') fx.confetti(lvl === 'lite' ? 16 : 40);
        if (m.mine && m.mine.fc && !still()) {
          const card = resultsBox.querySelector('.bd-me');
          if (card) cue.burst(card, { count: lvl === 'lite' ? 6 : 14, emoji: ['🎯', '🥁'] });
        }
      }
      if (m.phase === 'play') cue.play('start');
    }
  }

  function destroy() {
    gone = true;
    looping = false;
    closeTut();
    audio.destroy();
    local.songOn = false;
    player.destroy();
    if (typeof sfxOff === 'function') sfxOff();
    if (keyTarget) {
      keyTarget.removeEventListener('keydown', onBindKey, true);
      keyTarget.removeEventListener('keydown', onKey);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('visibilitychange', onVisible);
    }
    if (typeof w.removeEventListener === 'function') {
      w.removeEventListener('resize', onResize);
      w.removeEventListener('blur', letGo);
    }
    if (ro) ro.disconnect();
    letGo();
  }

  paintNote();

  return {
    el,
    update,
    destroy,
    press,
    frame,
    tick,
    player,
    audio,
    clock,
    openTut,
    release: releaseLane,
    get load() {
      return { ...load };
    },
    closeTut,
    prefs,
    get tut() {
      return tut;
    },
    get judge() {
      return local.judge;
    },
    get looping() {
      return looping;
    },
    get local() {
      return local;
    },
    get offset() {
      return prefs.tapOffset;
    },
  };
}
