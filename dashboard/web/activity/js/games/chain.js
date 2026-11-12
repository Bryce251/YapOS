import { jsonBytes } from '../limits.js';

export const KEY = 'chain';
export const MIN_LETTERS = 3;
export const MAX_LETTERS = 24;
export const RECENT = 10;
export const USED_BYTES = 2400;
export const WIN_BONUS = 250;
export const START_LETTERS = 'abcdefghilmnoprstw';

export function cleanWord(text) {
  const w = String(text ?? '').trim().toLowerCase();
  return w;
}

export function checkWord(text, letter, used) {
  const w = cleanWord(text);
  if (!w) return 'empty';
  if (!/^[a-z]+$/.test(w)) return 'letters';
  if (w.length < MIN_LETTERS) return 'short';
  if (w.length > MAX_LETTERS) return 'long';
  if (letter && w[0] !== letter) return 'start';
  if ((used || []).includes(w)) return 'used';
  return null;
}

export const PROBLEMS = Object.freeze({
  empty: 'Type a word first.',
  letters: 'Letters only, please. No spaces, numbers or symbols.',
  short: `Words need at least ${MIN_LETTERS} letters.`,
  long: `That word is too long. Keep it under ${MAX_LETTERS + 1} letters.`,
  start: 'That word starts with the wrong letter.',
  used: 'Someone already played that word.',
});

export function wordPoints(word) {
  return Math.min(150, 10 * String(word).length);
}

export function lastLetter(word) {
  const w = cleanWord(word);
  return w ? w[w.length - 1] : null;
}

export const MIN_VOTERS = 2;

export function voters(order, present, author, cur) {
  return order.filter((s) => s !== author && s !== cur && present.includes(s));
}

export function votesNeeded(eligible) {
  return Math.floor(eligible / 2) + 1;
}

export function nextUp(order, lives, present, from) {
  const live = new Set(present);
  const ok = (s) => (lives[s] || 0) > 0 && live.has(s);
  if (!order.length) return null;
  const at = order.indexOf(from);
  for (let i = 1; i <= order.length; i += 1) {
    const s = order[(Math.max(at, -1) + i + order.length) % order.length];
    if (ok(s)) return s;
  }
  return null;
}

export function standing(order, lives, present) {
  const live = new Set(present);
  return order.filter((s) => (lives[s] || 0) > 0 && live.has(s));
}

function trimUsed(list) {
  const out = list.slice();
  while (out.length > 1 && jsonBytes(out) > USED_BYTES) out.shift();
  return out;
}

function presentSlots(api) {
  return api.players().map((p) => p.slot);
}

function endIfDone(api, st) {
  const left = standing(st.order, st.lives, presentSlots(api));
  if (left.length > 1) return false;
  for (const s of left) api.addPoints(s, WIN_BONUS);
  api.put(KEY, { ...st, phase: 'over', winner: left.length ? left[0] : null });
  api.finish(left);
  return true;
}

function startTurn(api, st, slot, note) {
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const next = { ...st, phase: 'turn', cur: slot, t: (st.t || 0) + 1, note: note || null, starts, ends };
  api.put(KEY, next);
  api.setDeadline(ends);
  return next;
}

function loseLife(st, slot) {
  st.lives = { ...st.lives, [slot]: Math.max(0, (st.lives[slot] || 0) - 1) };
  if (!st.lives[slot] && !st.out.includes(slot)) st.out = st.out.concat([slot]);
}

function advance(api, st, note) {
  if (endIfDone(api, st)) return;
  const slot = nextUp(st.order, st.lives, presentSlots(api), st.cur);
  if (slot === null) {
    api.finish();
    return;
  }
  startTurn(api, st, slot, note);
}

function play(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'turn' || slot !== st.cur) return;
  if (action.t !== undefined && action.t !== st.t) return;
  if (checkWord(action.text, st.letter, st.used)) return;
  const word = cleanWord(action.text);
  const pts = wordPoints(word);
  api.addPoints(slot, pts);
  st.count = (st.count || 0) + 1;
  st.words = st.words.concat([[st.count, slot, word]]).slice(-RECENT);
  st.used = trimUsed(st.used.concat([word]));
  st.vote = { n: st.count, w: word, s: slot, no: [], prev: st.letter, pts };
  st.letter = lastLetter(word);
  st.last = { kind: 'word', s: slot, w: word };
  advance(api, st);
}

function nope(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'turn' || !st.vote) return;
  const v = st.vote;
  if (action.n !== v.n || slot === v.s || slot === st.cur || !st.order.includes(slot) || v.no.includes(slot)) return;
  const present = presentSlots(api);
  const eligible = voters(st.order, present, v.s, st.cur).length;
  if (eligible < MIN_VOTERS) return;
  v.no = v.no.concat([slot]);
  if (v.no.length < votesNeeded(eligible)) {
    api.put(KEY, st);
    return;
  }
  st.words = st.words.filter((x) => x[0] !== v.n);
  const at = st.used.lastIndexOf(v.w);
  if (at >= 0) st.used = st.used.slice(0, at).concat(st.used.slice(at + 1));
  st.letter = v.prev;
  st.struck = (st.struck || 0) + 1;
  st.vote = null;
  st.last = { kind: 'reject', s: v.s, w: v.w };
  api.addPoints(v.s, -v.pts);
  loseLife(st, v.s);
  if (endIfDone(api, st)) return;
  if (st.cur === v.s || !present.includes(st.cur) || !(st.lives[st.cur] > 0)) {
    advance(api, st);
    return;
  }
  startTurn(api, st, st.cur, 'again');
}

const chain = {
  id: 'chain',
  name: 'Word Chain',
  emoji: '🔗',
  blurb: 'Say a word that starts with the last letter of the one before. Run out of time and you lose a life.',
  minPlayers: 2,
  keys: [KEY],
  settings: [
    { id: 'timer', label: 'Time per turn', type: 'choice', options: [10, 15, 20].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    { id: 'lives', label: 'Lives', type: 'choice', options: [1, 2, 3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
  ],

  start(api) {
    const order = presentSlots(api);
    const lives = {};
    for (const s of order) lives[s] = api.settings.lives;
    const letter = START_LETTERS[Math.floor(api.random() * START_LETTERS.length)];
    const st = { v: 1, order, lives, max: api.settings.lives, out: [], letter, words: [], used: [], count: 0, vote: null, last: null, t: 0, cur: null, phase: 'turn' };
    const first = order[Math.floor(api.random() * order.length)];
    startTurn(api, st, first, 'first');
  },

  intent(api, slot, action) {
    if (action.type === 'word') return play(api, slot, action);
    if (action.type === 'nope') return nope(api, slot, action);
    return undefined;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase !== 'turn') return undefined;
    loseLife(st, st.cur);
    st.last = { kind: st.lives[st.cur] ? 'miss' : 'out', s: st.cur, w: null };
    return advance(api, st);
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return chain.start(api);
    if (st.phase !== 'turn') return undefined;
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    chain.roster(api);
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn') return;
    if (endIfDone(api, st)) return;
    if (!presentSlots(api).includes(st.cur)) {
      st.last = { kind: 'left', s: st.cur, w: null };
      advance(api, st);
    }
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      return p
        ? { slot, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar, isMe: p.isMe, present: p.present }
        : { slot, name: 'Player', initials: 'P', hue: 20, avatar: null, isMe: false, present: false };
    };
    const present = snap.players.filter((p) => p.present && p.slot !== null).map((p) => p.slot);
    const v = st.vote;
    let vote = null;
    if (v) {
      const eligible = voters(st.order, present, v.s, st.cur).length;
      const open = eligible >= MIN_VOTERS;
      const voted = v.no.includes(mine) || (local.nope === v.n);
      vote = {
        n: v.n,
        word: v.w,
        by: who(v.s),
        count: v.no.length,
        need: votesNeeded(eligible),
        voted,
        open,
        onClock: mine !== null && mine === st.cur,
        canVote: open && st.phase === 'turn' && mine !== null && mine !== v.s && mine !== st.cur && st.order.includes(mine) && !voted,
      };
    }
    const myTurn = st.phase === 'turn' && mine !== null && st.cur === mine;
    return {
      phase: st.phase,
      t: st.t,
      letter: st.letter,
      count: Math.max(0, (st.count || 0) - (st.struck || 0)),
      cur: st.cur === null ? null : who(st.cur),
      myTurn,
      playing: mine !== null && st.order.includes(mine),
      alive: mine !== null && (st.lives[mine] || 0) > 0,
      starts: st.starts,
      ends: st.ends,
      max: st.max,
      players: st.order.map((s) => ({ ...who(s), lives: st.lives[s] || 0, out: !(st.lives[s] > 0), isCur: s === st.cur })),
      words: st.words.map(([n, s, w]) => ({ n, word: w, ...who(s), latest: Boolean(v && v.n === n) })),
      vote,
      last: st.last ? { kind: st.last.kind, w: st.last.w, ...who(st.last.s) } : null,
      note: st.note,
    };
  },
};

export default chain;
