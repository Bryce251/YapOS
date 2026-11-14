import { WORDS, TIERS, wordById, wordsIn } from '../../data/draw.js';
import { shuffle } from '../engine.js';
import { INK_PREFIX } from './ink.js';
import { person } from '../players.js';

export const KEY = 'draw';
export const DRAWER_STEP = 5;
export const AUTO_START = Object.freeze({ min: 2, ms: 90000 });
export const HANDLE_MAX = 32;
export const PICK_MS = 15000;
export const REVEAL_MS = 6000;
export const GUESS_MAX = 500;
export const GUESS_MIN = 100;
export const FEED_MAX = 8;
export const GUESS_CHARS = 40;
export const USED_MAX = 150;
export const GUESS_GAP_MS = 400;

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function judge(guess, word) {
  const w = normalize(word);
  const g = normalize(guess);
  if (!g || !w) return 'miss';
  if (g === w) return 'right';
  const tokens = String(guess ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  for (let s = 0; s < tokens.length; s += 1) {
    let joined = '';
    for (let e = s; e < tokens.length && joined.length < w.length; e += 1) {
      joined += tokens[e];
      if (joined === w) return 'right';
    }
  }
  if (Math.abs(g.length - w.length) <= 1 && distance(g, w) === 1) return 'close';
  if (g.includes(w)) return 'hidden';
  return 'miss';
}

export function guessPoints(at, starts, ends) {
  const span = Math.max(1, ends - starts);
  const left = Math.min(1, Math.max(0, (ends - at) / span));
  return Math.round((GUESS_MIN + (GUESS_MAX - GUESS_MIN) * left) / 10) * 10;
}

export function drawerShare(points, guessers) {
  const list = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p) && p > 0);
  if (!list.length) return 0;
  const sum = list.reduce((a, b) => a + b, 0);
  const n = Math.max(1, list.length, Number.isFinite(guessers) ? Math.floor(guessers) : 0);
  return Math.floor(sum / n / DRAWER_STEP) * DRAWER_STEP;
}

export function drawerGain(got, guessers, already = 0) {
  return Math.max(0, drawerShare(got.map((g) => g[1]), guessers) - (already || 0));
}

export function handleOf(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^@+/, '').replace(/[\s\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > HANDLE_MAX ? chars.slice(0, HANDLE_MAX).join('') : text;
}

export function mask(id, nonce) {
  return (id ^ nonce) & 0xffff;
}

export function unmask(code, nonce) {
  return (code ^ nonce) & 0xffff;
}

export function chooseWords(level, used, random = Math.random) {
  const seen = new Set(used || []);
  const from = (tier) => {
    const all = tier ? wordsIn(tier) : WORDS.slice();
    const fresh = all.filter((x) => !seen.has(x.id));
    return shuffle(fresh.length >= 3 ? fresh : all, random);
  };
  if (level === 'mix') {
    const out = [];
    for (const t of TIERS) {
      const pick = from(t.id).find((x) => !out.includes(x.id));
      if (pick) out.push(pick.id);
    }
    return out;
  }
  return from(TIERS.some((t) => t.id === level) ? level : null)
    .slice(0, 3)
    .map((x) => x.id);
}

export function nextSeat(order, present, round, pos, rounds) {
  const live = new Set(present);
  if (!order.length) return null;
  let r = round;
  let p = pos;
  for (let guard = 0; guard <= order.length * (rounds + 1); guard += 1) {
    if (p >= order.length) {
      r += 1;
      p = 0;
    }
    if (r > rounds) return null;
    if (live.has(order[p])) return { round: r, pos: p, slot: order[p] };
    p += 1;
  }
  return null;
}

export function hintSpots(word, nonce) {
  const spots = [];
  for (let i = 0; i < word.length; i += 1) if (/[a-z]/i.test(word[i])) spots.push(i);
  let s = (nonce >>> 0) || 1;
  for (let i = spots.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  return spots;
}

export function hintCount(word, starts, ends, now) {
  const letters = normalize(word).length;
  const left = (ends - now) / Math.max(1, ends - starts);
  let n = 0;
  if (letters >= 4 && left <= 0.5) n = 1;
  if (letters >= 6 && left <= 0.25) n = 2;
  return n;
}

export function blanks(word, shown, nonce) {
  const open = new Set(hintSpots(word, nonce).slice(0, shown));
  return Array.from(word).map((ch, i) => (ch === ' ' ? ' ' : open.has(i) ? ch : '_'));
}

function presentSlots(api) {
  return api.players().map((p) => p.slot);
}

function clearInk(api) {
  for (const k of api.keys()) if (k.startsWith(INK_PREFIX)) api.put(k, null);
}

function wordOf(st) {
  if (!st || st.w === null || st.w === undefined) return null;
  const w = wordById(unmask(st.w, st.nonce));
  return w ? w.w : null;
}

function pushFeed(st, slot, text, kind) {
  st.fid = (st.fid || 0) + 1;
  st.feed = (st.feed || []).concat([[st.fid, slot, text, kind]]).slice(-FEED_MAX);
}

function turn(api, prev, round, pos) {
  clearInk(api);
  const present = presentSlots(api);
  const order = prev.order.slice();
  for (const s of present) if (!order.includes(s)) order.push(s);
  const seat = nextSeat(order, present, round, pos, prev.rounds);
  if (!seat || present.length < 2) return api.finish();
  const nonce = 1 + Math.floor(api.random() * 65535);
  const ids = chooseWords(api.settings.words, prev.used, api.random);
  const starts = api.now();
  const ends = starts + PICK_MS;
  api.put(KEY, {
    v: 1,
    rounds: prev.rounds,
    round: seat.round,
    pos: seat.pos,
    order,
    n: (prev.n || 0) + 1,
    drawer: seat.slot,
    phase: 'pick',
    nonce,
    opts: ids.map((id) => mask(id, nonce)),
    w: null,
    word: null,
    got: [],
    feed: [],
    fid: 0,
    gained: {},
    used: (prev.used || []).concat(ids).slice(-USED_MAX),
    note: null,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function choose(api, st, i) {
  const code = st.opts[i];
  if (code === undefined) return;
  const starts = api.now();
  const ends = starts + api.settings.time * 1000;
  api.put(KEY, { ...st, phase: 'draw', w: code, opts: [], starts, ends });
  api.setDeadline(ends);
}

function reveal(api, note) {
  const st = api.get(KEY);
  if (!st || (st.phase !== 'draw' && st.phase !== 'pick')) return;
  if (st.phase === 'pick') {
    turn(api, st, st.round, st.pos + 1);
    return;
  }
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', word: wordOf(st), note: note || null, starts: api.now(), ends });
  api.setDeadline(ends);
}

function everyoneGot(api, st) {
  const guessers = presentSlots(api).filter((s) => s !== st.drawer);
  return guessers.length > 0 && guessers.every((s) => st.got.some((g) => g[0] === s));
}

function guesserCount(api, st) {
  const all = new Set(presentSlots(api).filter((s) => s !== st.drawer));
  for (const g of st.got) all.add(g[0]);
  return all.size;
}

function guess(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'draw' || slot === st.drawer) return;
  if (st.got.some((g) => g[0] === slot)) return;
  const raw = typeof action.text === 'string' ? action.text.replace(/\s+/g, ' ').trim() : '';
  if (!raw || raw.length > GUESS_CHARS || !normalize(raw)) return;
  const at = api.now();
  const gaps = (api.memory.gaps = api.memory.gaps || {});
  if (gaps[slot] && at - gaps[slot] < GUESS_GAP_MS) return;
  gaps[slot] = at;
  const word = wordOf(st);
  if (!word) return;
  const verdict = judge(raw, word);
  if (verdict === 'right') {
    const pts = guessPoints(Math.min(at, st.ends), st.starts, st.ends);
    st.got.push([slot, pts]);
    const had = (st.gained && st.gained[st.drawer]) || 0;
    const extra = drawerGain(st.got, guesserCount(api, st), had);
    st.gained = { ...st.gained, [slot]: pts, [st.drawer]: had + extra };
    api.addPoints(slot, pts);
    if (extra) api.addPoints(st.drawer, extra);
    pushFeed(st, slot, '', 'ok');
  } else {
    pushFeed(st, slot, verdict === 'hidden' ? '•••' : raw, verdict === 'close' ? 'close' : 'guess');
  }
  api.put(KEY, st);
  if (verdict === 'right' && everyoneGot(api, st)) reveal(api, 'all');
}

const draw = {
  id: 'draw',
  name: 'Draw & Guess',
  emoji: '🎨',
  blurb: 'Take turns drawing a secret word. Guess fast to score big.',
  minPlayers: 2,
  autoStart: { min: AUTO_START.min, ms: AUTO_START.ms },
  keys: [KEY],
  prefixes: [INK_PREFIX],
  open: [INK_PREFIX],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
    { id: 'time', label: 'Time to draw', type: 'choice', options: [60, 80, 100].map((v) => ({ value: v, label: `${v} s` })), default: 80 },
    {
      id: 'words',
      label: 'Words',
      type: 'choice',
      options: [{ value: 'mix', label: '🎲 Mixed' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))),
      default: 'mix',
    },
  ],

  writer(get, key, slot, value) {
    if (!key.startsWith(INK_PREFIX)) return false;
    const st = get(KEY);
    if (!st || !Number.isInteger(slot) || slot !== st.drawer) return false;
    return value === null || Boolean(value && typeof value === 'object' && value.k === st.nonce);
  },

  start(api) {
    const order = presentSlots(api);
    turn(api, { order, rounds: api.settings.rounds, used: [], n: 0 }, 1, 0);
  },

  intent(api, slot, action) {
    if (action.type === 'guess') return guess(api, slot, action);
    if (action.type === 'pick') {
      const st = api.get(KEY);
      if (!st || st.phase !== 'pick' || slot !== st.drawer) return undefined;
      if (action.n !== undefined && action.n !== st.n) return undefined;
      if (!Number.isInteger(action.i) || action.i < 0 || action.i >= st.opts.length) return undefined;
      return choose(api, st, action.i);
    }
    return undefined;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'pick') return choose(api, st, Math.floor(api.random() * st.opts.length));
    if (st.phase === 'draw') return reveal(api, 'time');
    return turn(api, st, st.round, st.pos + 1);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'pick' && st.phase !== 'draw' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'reveal') turn(api, st, st.round, st.pos + 1);
      else reveal(api, 'skip');
      return true;
    }
    if (action.type === 'time') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st || !Number.isInteger(slot)) return undefined;
    if (!Array.isArray(st.order) || st.order.includes(slot)) return undefined;
    api.put(KEY, { ...st, order: st.order.concat([slot]) });
    return undefined;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return draw.start(api);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    draw.roster(api);
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase === 'reveal') return;
    const present = presentSlots(api);
    if (present.length < 2) return api.finish();
    if (!present.includes(st.drawer)) return reveal(api, 'left');
    if (st.phase === 'draw' && everyoneGot(api, st)) return reveal(api, 'all');
    return undefined;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const now = local.now ?? snap.now;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      if (!p) return { slot, id: null, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false };
      const prof = person({ id: p.id, name: p.name }) || {};
      return { slot, id: p.id, name: p.name, username: handleOf(p.username || prof.username || null), initials: p.initials, hue: p.hue, avatar: p.avatar || prof.avatar || null, isMe: p.isMe };
    };
    const amDrawer = mine !== null && mine === st.drawer;
    const playing = mine !== null && snap.meJoined !== false;
    const secret = wordOf(st);
    const shown = st.phase === 'reveal' ? st.word || secret : null;
    let word = null;
    if (amDrawer || st.phase === 'reveal') word = shown || secret;
    let hint = null;
    if (st.phase === 'draw' && secret && !amDrawer) {
      const gotIt = st.got.some((g) => g[0] === mine);
      hint = gotIt ? Array.from(secret) : blanks(secret, hintCount(secret, st.starts, st.ends, now), st.nonce);
    }
    const choices =
      amDrawer && st.phase === 'pick'
        ? st.opts.map((code, i) => {
            const w = wordById(unmask(code, st.nonce));
            return w ? { i, word: w.w, tier: w.tier } : null;
          }).filter(Boolean)
        : [];
    const gotMe = st.got.find((g) => g[0] === mine);
    return {
      phase: st.phase,
      n: st.n,
      round: st.round,
      rounds: st.rounds,
      k: st.nonce,
      drawer: who(st.drawer),
      amDrawer,
      choices,
      word,
      hint,
      letters: secret ? normalize(secret).length : 0,
      words: secret ? secret.trim().split(/\s+/).length : 0,
      starts: st.starts,
      ends: st.ends,
      got: st.got.map(([slot, pts]) => ({ ...who(slot), pts })),
      gotMe: Boolean(gotMe),
      myPts: gotMe ? gotMe[1] : 0,
      canGuess: st.phase === 'draw' && !amDrawer && playing && !gotMe,
      feed: (st.feed || []).map(([id, slot, text, kind]) => ({ id, ...who(slot), text: kind === 'close' && slot !== mine ? '' : text, kind, mine: slot === mine })),
      gained: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      drawerGain: st.gained ? st.gained[st.drawer] || 0 : 0,
      note: st.note,
      spectator: !playing && !amDrawer,
    };
  },
};

export default draw;
