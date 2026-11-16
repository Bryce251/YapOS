import { ITEMS, KINDS, itemById, showValue } from '../../data/higherlower.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';
import { KO_ROUND_CAP, SURVIVOR_POINTS, koSetting, koOn, koOut, koTotal, koModel } from './knockout.js';

export const KEY = 'higherlower';
export const REVEAL_MS = 4000;
export const BASE_POINTS = 100;
export const STREAK_STEP = 25;
export const STREAK_CAP = 8;
export const LATE_MIN_MS = 3000;
export const FAST_MS = 1500;
export const CLOSE_RATIO = 1.3;
export const HL_KEEP = 3;

export function pointsFor(streak) {
  const s = Math.max(1, Math.floor(streak) || 1);
  return BASE_POINTS + STREAK_STEP * Math.min(STREAK_CAP, s - 1);
}

export function fairPair(a, b) {
  if (!a || !b || a.id === b.id || a.kind !== b.kind || a.value === b.value) return false;
  const k = KINDS[a.kind];
  const hi = Math.max(a.value, b.value);
  const lo = Math.min(a.value, b.value);
  if (a.kind === 'year') return hi !== lo;
  return lo > 0 && hi / lo >= (k ? k.gap : 1.1);
}

export function buildDeck(count, random = Math.random) {
  const n = Math.max(1, Math.floor(count) || 1);
  const used = new Set();
  const kinds = Object.keys(KINDS);
  const byKind = new Map(kinds.map((k) => [k, ITEMS.filter((x) => x.kind === k)]));
  const out = [];
  let order = shuffle(kinds, random);
  let guard = 0;
  while (out.length < n && guard < n * 40) {
    guard += 1;
    if (!order.length) order = shuffle(kinds, random);
    const kind = order.shift();
    const pool = shuffle(byKind.get(kind).filter((x) => !used.has(x.id)), random);
    let pair = null;
    for (let i = 0; i < pool.length && !pair; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        if (fairPair(pool[i], pool[j])) {
          pair = [pool[i], pool[j]];
          break;
        }
      }
    }
    if (!pair) continue;
    used.add(pair[0].id);
    used.add(pair[1].id);
    out.push([pair[0].id, pair[1].id]);
  }
  return out;
}

export function higherSide(aId, bId) {
  const a = itemById(aId);
  const b = itemById(bId);
  if (!a || !b) return null;
  return a.value > b.value ? 'a' : 'b';
}

export function score(picks, right, streaks, playing) {
  const next = { ...(streaks || {}) };
  const gained = {};
  for (const slot of playing) {
    if (picks[slot] && picks[slot] === right) {
      next[slot] = (next[slot] || 0) + 1;
      gained[slot] = pointsFor(next[slot]);
    } else {
      next[slot] = 0;
    }
  }
  return { streaks: next, gained };
}

export function pickOrder(picks, times, right, slots) {
  const at = (s) => (times && Number.isFinite(times[s]) ? times[s] : Infinity);
  const list = (slots || []).filter(Number.isInteger);
  const ok = list.filter((s) => picks[s] && picks[s] === right).sort((a, b) => at(a) - at(b) || a - b);
  const bad = list.filter((s) => picks[s] && picks[s] !== right).sort((a, b) => at(a) - at(b) || a - b);
  const none = list.filter((s) => !picks[s]).sort((a, b) => a - b);
  return ok.map((s) => ({ s, ok: true })).concat(bad.map((s) => ({ s, ok: false })), none.map((s) => ({ s, ok: false })));
}

function say(api, kind, data) {
  if (api && typeof api.say === 'function') api.say(kind, data);
}

function tick(api, n, total) {
  if (api && typeof api.round === 'function') api.round(n, total);
}

function give(api, slot, n) {
  const got = api.addPoints(slot, n);
  return Number.isFinite(got) ? got : n;
}

function shown(item) {
  return { id: item.id, n: item.name, e: item.emoji };
}

function present(api) {
  return api.players().map((p) => p.slot);
}

function ask(api, deck, i, note) {
  const pair = deck[i];
  const a = pair && itemById(pair[0]);
  const b = pair && itemById(pair[1]);
  if (!a || !b) return next(api, deck, i);
  const prev = api.get(KEY);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const r = (prev && prev.r ? prev.r : 0) + 1;
  const ko = prev ? Boolean(prev.ko) : false;
  const al = ko && Array.isArray(prev.al) ? prev.al : null;
  const here = present(api);
  if (ko) tick(api, r, koTotal(r, al));
  else tick(api, i + 1, deck.length);
  api.memory.cur = { r, picks: {}, at: {} };
  const st = {
    deck,
    i,
    r,
    total: deck.length,
    phase: 'guess',
    kind: a.kind,
    a: shown(a),
    b: shown(b),
    in: ko ? al.filter((s) => here.includes(s)) : here,
    wait: [],
    done: [],
    picks: null,
    right: null,
    vals: null,
    streaks: prev && prev.streaks ? prev.streaks : {},
    best: prev && prev.best ? prev.best : {},
    gained: {},
    note: note || null,
    starts,
    ends,
  };
  if (ko) {
    st.ko = 1;
    st.al = al;
    st.ot = Array.isArray(prev.ot) ? prev.ot : [];
    st.kx = [];
  }
  if (prev && Array.isArray(prev.hl)) st.hl = prev.hl;
  api.put(KEY, st);
  api.setDeadline(ends);
  return undefined;
}

function next(api, deck, i) {
  const st = api.get(KEY);
  if (st && st.ko) {
    const al = Array.isArray(st.al) ? st.al : [];
    if (al.length <= 1) return api.finish(al.slice());
    if ((st.r || 0) >= KO_ROUND_CAP || i + 1 >= deck.length) return api.finish(topOf(al, api.points()));
    return ask(api, deck, i + 1);
  }
  if (i + 1 < deck.length && api.players().length) return ask(api, deck, i + 1);
  return api.finish();
}

function topOf(slots, pts) {
  const list = (slots || []).filter(Number.isInteger);
  if (!list.length) return undefined;
  const hi = Math.max(...list.map((s) => Number(pts[s]) || 0));
  return list.filter((s) => (Number(pts[s]) || 0) === hi);
}

function playingNow(api, st) {
  const live = present(api);
  return Array.isArray(st.in) ? live.filter((s) => st.in.includes(s)) : live;
}

function everyoneIn(api, st) {
  const live = playingNow(api, st);
  return live.length > 0 && live.every((s) => st.done.includes(s));
}

function upsetLine(st, picks, right) {
  const total = Object.keys(picks).length;
  const good = Object.values(picks).filter((x) => x === right).length;
  if (total < 3 || good * 3 > total) return null;
  const win = right === 'a' ? st.a : st.b;
  const lose = right === 'a' ? st.b : st.a;
  const text = good === 0 ? `😱 Nobody believed ${win.n} beats ${lose.n}` : `😱 Only ${good} of ${total} knew ${win.n} beats ${lose.n}`;
  return { x: text.length > 118 ? `${text.slice(0, 117)}…` : text, w: total - good };
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  const cur = api.memory.cur;
  const picks = cur && cur.r === st.r ? cur.picks : {};
  const times = cur && cur.r === st.r ? cur.at || {} : {};
  const right = higherSide(st.a.id, st.b.id);
  const playing = (Array.isArray(st.in) ? st.in : []).filter((s) => Number.isInteger(s));
  const result = score(picks, right, st.streaks, playing);
  const best = { ...(st.best || {}) };
  for (const [slot, n] of Object.entries(result.streaks)) if (n > (best[slot] || 0)) best[slot] = n;
  const gained = {};
  for (const [slot, pts] of Object.entries(result.gained)) gained[slot] = give(api, Number(slot), pts);
  const order = pickOrder(picks, times, right, playing);
  const quick = order.find((x) => x.ok && Number.isFinite(times[x.s]) && times[x.s] - st.starts <= FAST_MS);
  const va = itemById(st.a.id);
  const vb = itemById(st.b.id);
  const close = va && vb && st.kind !== 'year' && Math.max(va.value, vb.value) / Math.max(1e-9, Math.min(va.value, vb.value)) < CLOSE_RATIO;
  const missed = order.find((x) => !x.ok && picks[x.s]);
  const patch = {};
  if (st.ko) {
    const al = (Array.isArray(st.al) ? st.al : []).filter(Number.isInteger);
    const out = koOut(al, pickOrder(picks, times, right, al));
    const left = al.filter((s) => !out.includes(s));
    patch.al = left;
    patch.kx = out;
    patch.ot = (Array.isArray(st.ot) ? st.ot : []).concat(out);
    for (const s of out) say(api, 'out', { slot: s });
    if (left.length === 1 && al.length > 1) {
      const bonus = give(api, left[0], SURVIVOR_POINTS);
      gained[left[0]] = (gained[left[0]] || 0) + bonus;
      patch.sv = bonus;
    }
  }
  if (close && missed) say(api, 'close', { slot: missed.s });
  else if (quick) say(api, 'fast', { slot: quick.s });
  const up = upsetLine(st, picks, right);
  if (up) {
    const list = (Array.isArray(st.hl) ? st.hl : []).concat([up]).sort((x, y) => y.w - x.w).slice(0, HL_KEEP);
    patch.hl = list;
  }
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, {
    ...st,
    ...patch,
    phase: 'reveal',
    picks,
    right,
    vals: { a: showValue(itemById(st.a.id)), b: showValue(itemById(st.b.id)) },
    streaks: result.streaks,
    best,
    gained,
    starts: api.now(),
    ends,
  });
  api.setDeadline(ends);
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'guess' || st.ko) return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function bestOf(map, min) {
  let top = null;
  for (const [slot, n] of Object.entries(map || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !(n >= min)) continue;
    if (!top || n > top.n || (n === top.n && s < top.slot)) top = { slot: s, n };
  }
  return top;
}

const higherlower = {
  id: 'higherlower',
  name: 'Higher or Lower',
  emoji: '📈',
  category: 'quick',
  blurb: 'Two things, one hidden number. Pick the bigger one fast, build a streak, and survive the knockout.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to pick', type: 'choice', options: [5, 8, 10, 15].map((v) => ({ value: v, label: `${v} s` })), default: 8 },
    koSetting(),
  ],

  start(api) {
    const here = present(api);
    const ko = koOn(api.settings, here.length);
    const size = ko ? Math.min(KO_ROUND_CAP, Math.max(api.settings.rounds, here.length * 2 + 4)) : api.settings.rounds;
    const deck = buildDeck(size, api.random);
    if (ko) api.put(KEY, { r: 0, ko: 1, al: here.slice(), ot: [] });
    ask(api, deck, 0);
  },

  hint(api, slot) {
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'guess' || !cur || cur.r !== st.r || cur.picks[slot]) return null;
    const side = api.random() < 0.5 ? 'a' : 'b';
    const item = itemById(st[side].id);
    return item ? `${item.name}: ${showValue(item)}` : null;
  },

  awards(api) {
    const st = api.get(KEY);
    if (!st) return [];
    const out = [];
    if (st.ko && Array.isArray(st.al) && st.al.length === 1) out.push({ emoji: '🥊', title: 'Last one standing', who: st.al[0], why: 'Survived every knockout round' });
    const streak = bestOf(st.best, 4);
    if (streak) out.push({ emoji: '🔥', title: 'Streak machine', who: streak.slot, why: `${streak.n} right in a row` });
    if (st.ko && Array.isArray(st.ot) && st.ot.length >= 2) out.push({ emoji: '🍂', title: 'First to fall', who: st.ot[0], why: 'Somebody had to go first. Very brave.' });
    return out;
  },

  highlights(api) {
    const st = api.get(KEY);
    return st && Array.isArray(st.hl) ? st.hl.map((x) => ({ text: x.x })) : [];
  },

  results(api) {
    const st = api.get(KEY);
    if (!st || !st.ko) return {};
    const al = Array.isArray(st.al) ? st.al : [];
    return al.length === 1 ? { note: `🥊 ${api.nameOf(al[0])} won the knockout` } : {};
  },

  intent(api, slot, action) {
    if (!action || action.type !== 'pick' || (action.side !== 'a' && action.side !== 'b')) return;
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'guess' || !cur || cur.r !== st.r) return;
    if (action.r !== undefined && action.r !== st.r) return;
    if (cur.picks[slot]) return;
    if (!st.in.includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!st.in.includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    cur.picks[slot] = action.side;
    if (cur.at) cur.at[slot] = Math.min(api.now(), st.ends);
    if (!st.done.includes(slot)) st.done.push(slot);
    api.put(KEY, st);
    if (everyoneIn(api, st)) reveal(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st || !Array.isArray(st.deck)) return api.finish();
    if (st.phase === 'guess') return reveal(api);
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'guess' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      higherlower.deadline(api);
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

  resume(api) {
    const st = api.get(KEY);
    if (!st || !Array.isArray(st.deck)) return higherlower.start(api);
    if (st.phase === 'guess') {
      const cur = api.memory.cur;
      if (!cur || cur.r !== st.r) return ask(api, st.deck, st.i, 'host');
    }
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'guess') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneIn(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !st.a) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : null;
    };
    const revealed = st.phase === 'reveal';
    const playing = Array.isArray(st.in) ? st.in : [];
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || !playing.includes(mine));
    const myPick = revealed ? (st.picks && st.picks[mine]) || null : local.r === st.r ? local.side || null : null;
    const sideOf = (side) =>
      Object.entries(st.picks || {})
        .filter(([, v]) => v === side)
        .map(([s]) => faceOf(Number(s)))
        .filter(Boolean);
    const live = playing.filter((s) => bySlot.has(s) && bySlot.get(s).present);
    const kind = KINDS[st.kind] || null;
    const streak = mine !== null && st.streaks ? st.streaks[mine] || 0 : 0;
    const hot = Object.entries(st.streaks || {})
      .filter(([, n]) => n >= 3)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([s, n]) => ({ who: faceOf(Number(s)), n }))
      .filter((x) => x.who);
    const ko = koModel(st, mine, bySlot, face);
    return {
      phase: st.phase,
      r: st.r,
      number: ko ? st.r : st.i + 1,
      total: st.total,
      ask: kind ? kind.ask : 'Which is bigger?',
      kind: st.kind,
      a: { name: st.a.n, emoji: st.a.e, value: revealed && st.vals ? st.vals.a : null },
      b: { name: st.b.n, emoji: st.b.e, value: revealed && st.vals ? st.vals.b : null },
      starts: st.starts,
      ends: st.ends,
      note: st.note,
      waiting,
      watching,
      canPick: st.phase === 'guess' && !waiting && !watching && !myPick,
      myPick,
      right: revealed ? st.right : null,
      correct: revealed ? Boolean(myPick) && myPick === st.right : null,
      done: st.done.length,
      players: live.length || playing.length,
      doneBy: st.done.map(faceOf).filter(Boolean),
      pickers: { a: revealed ? sideOf('a') : [], b: revealed ? sideOf('b') : [] },
      streak,
      best: mine !== null && st.best ? st.best[mine] || 0 : 0,
      hot,
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      ko: ko ? { ...ko, out: revealed ? ko.out : [] } : null,
      survivor: revealed && st.sv ? st.sv : 0,
    };
  },
};

export default higherlower;
