import { face } from './trivia.js';
import { award, roundAt, say, streak, missRest, bump, bestStreak, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'memory';
export const PADS = 4;
export const MAX_LEN = 40;
export const MAX_ROUNDS = 15;
export const LEAD_MS = 1200;
export const TAIL_MS = 400;
export const INPUT_BASE_MS = 4000;
export const INPUT_PER_MS = 700;
export const RESULT_MS = 3000;
export const STEP = Object.freeze({ normal: { base: 700, drop: 30, min: 320 }, fast: { base: 520, drop: 25, min: 240 } });
export const BASE_POINTS = 50;
export const PER_PAD = 10;
export const SPEED_BONUS = Object.freeze([30, 20, 10]);
export const SURVIVOR_POINTS = 200;

export function stepMs(len, speed) {
  const s = STEP[speed] || STEP.normal;
  return Math.max(s.min, s.base - s.drop * Math.max(0, len - 1));
}

function keyStream(k, n) {
  const out = [];
  let x = (k >>> 0) || 1;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out.push(x % PADS);
  }
  return out;
}

export function maskSeq(seq, k) {
  const ks = keyStream(k, seq.length);
  return seq.map((p, i) => (p + ks[i]) % PADS).join('');
}

export function unmaskSeq(code, k) {
  const s = typeof code === 'string' ? code : '';
  const ks = keyStream(k, s.length);
  return Array.from(s).map((ch, i) => (Number(ch) - ks[i] + PADS * 2) % PADS);
}

export function cleanTry(raw, len) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > len) return null;
  return /^[0-3]+$/.test(raw) ? raw : null;
}

export function pointsFor(len, place) {
  return BASE_POINTS + PER_PAD * len + (SPEED_BONUS[place - 1] || 0);
}

function lifeSetting(api) {
  const n = Number(api.settings.lives);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 2;
}

function speedOf(st) {
  return st.sp === 'fast' ? 'fast' : 'normal';
}

function present(api) {
  return new Set(api.players().map((p) => p.slot));
}

function aliveOf(api, st) {
  const here = present(api);
  return (st.in || []).filter((s) => here.has(s) && st.ps[s] && st.ps[s][0] > 0);
}

function showRound(api, st) {
  const k = st.k;
  const seq = unmaskSeq(st.sq, k);
  while (seq.length < st.len) seq.push(Math.floor(api.random() * PADS));
  const here = present(api);
  const lives = lifeSetting(api);
  const ps = { ...st.ps };
  const inn = (st.in || []).filter((s) => here.has(s) || (ps[s] && ps[s][0] <= 0));
  for (const s of st.wait || []) {
    if (!here.has(s) || inn.includes(s)) continue;
    inn.push(s);
    ps[s] = [lives, 0, 0, 0];
  }
  for (const s of inn) if (ps[s]) ps[s] = [ps[s][0], 0, 0, ps[s][3] || 0];
  const step = stepMs(st.len, speedOf(st));
  const now = api.now();
  const starts = now + LEAD_MS;
  const ends = starts + step * st.len + TAIL_MS;
  roundAt(api, st.r + 1, MAX_ROUNDS);
  const next = { ...st, r: st.r + 1, phase: 'show', sq: maskSeq(seq, k), ps, in: inn, wait: [], step, starts, ends, fin: 0, gained: {}, lost: [], outs: [] };
  api.put(KEY, next);
  api.setDeadline(ends);
}

function openInput(api, st) {
  const now = api.now();
  const ends = now + INPUT_BASE_MS + INPUT_PER_MS * st.len;
  api.put(KEY, { ...st, phase: 'input', starts: now, ends });
  api.setDeadline(ends);
}

function settle(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'input') return;
  const here = present(api);
  const lost = [];
  const outs = [];
  const gained = {};
  const hits = [];
  for (const s of st.in) {
    const row = st.ps[s];
    if (!row || row[0] <= 0) continue;
    if (row[1] === 1) {
      const pts = pointsFor(st.len, row[2]);
      gained[s] = award(api, s, pts);
      hits.push(s);
      bump(api, 'clean', s);
      continue;
    }
    if (!here.has(s) && row[1] === 0) continue;
    row[0] = Math.max(0, row[0] - 1);
    row[1] = row[1] || 3;
    lost.push(s);
    if (row[0] === 0) {
      outs.push(s);
      say(api, 'out', { slot: s });
    }
  }
  for (const s of hits) streak(api, s, true);
  missRest(api, hits);
  for (const s of hits) {
    const row = st.ps[s];
    row[3] = Math.max(row[3] || 0, st.len);
  }
  if (hits.length === 1 && st.in.length > 1) keep(api, `${nameOf(api, hits[0])} was the only one to nail a ${st.len}-pad chain`, hits[0], 2 + st.len / 5);
  const wasAlive = st.in.filter((s) => st.ps[s] && (st.ps[s][0] > 0 || outs.includes(s)) && here.has(s));
  const now = api.now();
  const next = { ...st, phase: 'result', gained, lost, outs, was: wasAlive, starts: now, ends: now + RESULT_MS };
  api.put(KEY, next);
  api.setDeadline(now + RESULT_MS);
}

function advance(api, st) {
  const alive = aliveOf(api, st);
  if (alive.length === 0) {
    const was = (st.was || []).filter((s) => present(api).has(s));
    return api.finish(was.length ? was : undefined);
  }
  if (alive.length === 1 && (st.in || []).length > 1) {
    const sv = award(api, alive[0], SURVIVOR_POINTS);
    keep(api, `${nameOf(api, alive[0])} outlasted everyone with a ${st.len}-pad chain`, alive[0], 4);
    api.put(KEY, { ...st, sv });
    return api.finish(alive);
  }
  if (st.len >= MAX_LEN || st.r >= MAX_ROUNDS) return api.finish(alive);
  return showRound(api, { ...st, len: st.len + 1 });
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot)) return false;
  if ((st.in || []).includes(slot) || (st.wait || []).includes(slot)) return false;
  if (st.phase === 'show' && api.now() < st.starts) {
    st.in.push(slot);
    st.ps[slot] = [lifeSetting(api), 0, 0, 0];
  } else st.wait.push(slot);
  return true;
}

function allIn(api, st) {
  const alive = aliveOf(api, st);
  return alive.length > 0 && alive.every((s) => st.ps[s][1] !== 0);
}

function onTry(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'input' || action.r !== st.r) return;
  const row = st.ps[slot];
  if (!row || !st.in.includes(slot) || row[0] <= 0 || row[1] !== 0) return;
  const got = cleanTry(action.s, st.len);
  if (!got) return;
  const seq = unmaskSeq(st.sq, st.k).join('');
  if (got === seq) {
    st.fin = (st.fin || 0) + 1;
    row[1] = 1;
    row[2] = st.fin;
    if (st.fin === 1 && st.in.length > 1) say(api, 'fast', { slot });
  } else {
    row[1] = 2;
    row[2] = 0;
  }
  api.put(KEY, st);
  if (allIn(api, st)) settle(api);
}

const memory = {
  id: 'memory',
  name: 'Memory Chain',
  emoji: '💡',
  category: 'quick',
  blurb: 'Watch the pads light up, then repeat the chain. It grows by one every round and speeds up. A slip costs a life.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double'],
  settings: [
    { id: 'lives', label: 'Lives', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
    { id: 'start', label: 'Starting chain', type: 'choice', options: [3, 4, 5].map((v) => ({ value: v, label: `${v} pads` })), default: 3 },
    {
      id: 'speed',
      label: 'Speed',
      type: 'choice',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'fast', label: 'Fast' },
      ],
      default: 'normal',
    },
  ],

  start(api) {
    const here = api.players().map((p) => p.slot);
    const lives = lifeSetting(api);
    const ps = {};
    for (const s of here) ps[s] = [lives, 0, 0, 0];
    const start = Math.max(1, Math.min(MAX_LEN, Number(api.settings.start) || 3));
    const k = 1 + Math.floor(api.random() * 65534);
    showRound(api, { v: 1, r: 0, k, lv: lives, sq: '', len: start, sp: api.settings.speed === 'fast' ? 'fast' : 'normal', ps, in: here, wait: [] });
  },

  intent(api, slot, action) {
    if (action && action.type === 'try') onTry(api, slot, action);
  },

  results(api) {
    const st = api.get(KEY);
    if (!st) return {};
    const alive = aliveOf(api, st);
    if (st.sv && alive.length === 1) return { note: `💡 ${nameOf(api, alive[0])} remembered the longest chain` };
    if (st.r >= MAX_ROUNDS && alive.length) return { note: `💡 ${alive.length === 1 ? nameOf(api, alive[0]) : `${alive.length} players`} made it through all ${MAX_ROUNDS} chains` };
    return { note: `💡 The chain reached ${st.len} pads` };
  },

  awards(api) {
    funMem(api);
    const st = api.get(KEY);
    const out = [];
    if (st) {
      const alive = aliveOf(api, st);
      if (st.sv && alive.length === 1) out.push({ emoji: '🐘', title: 'Elephant memory', who: alive[0], why: 'Last one standing' });
      let top = null;
      for (const [k, row] of Object.entries(st.ps || {})) {
        const s = Number(k);
        if (row[3] > 0 && (!top || row[3] > top.n)) top = { slots: [s], n: row[3] };
        else if (top && row[3] === top.n) top.slots.push(s);
      }
      if (top && top.n >= 4) out.push({ emoji: '🔗', title: 'Longest chain', who: top.slots, why: `Repeated ${top.n} pads in a row` });
    }
    const hot = bestStreak(api);
    return list(...out, hot ? { emoji: '🔥', title: 'Flawless run', who: hot.slots, why: `Got ${hot.n} chains right in a row` } : null);
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'show') return openInput(api, st);
    if (st.phase === 'input') return settle(api);
    return advance(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st) return false;
    if (action.type === 'skip') {
      memory.deadline(api);
      return true;
    }
    if (action.type === 'time' && st.phase === 'input') {
      const ends = Math.max(api.now() + 1000, api.shift(st.ends, action.ms));
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return memory.start(api);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st) return;
    const here = present(api);
    const gone = (st.in || []).filter((s) => !here.has(s) && st.ps[s] && st.ps[s][0] > 0);
    if (gone.length) {
      st.ps = { ...st.ps };
      for (const s of gone) st.ps[s] = [0, ...st.ps[s].slice(1)];
      st.wait = (st.wait || []).filter((s) => here.has(s));
      api.put(KEY, st);
    }
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (st.phase === 'input' && allIn(api, st)) settle(api);
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st || !st.ps) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const here = new Set(snap.players.filter((p) => p.present).map((p) => p.slot));
    const row = mine !== null && mine !== undefined && (st.in || []).includes(mine) ? st.ps[mine] : null;
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const result = st.phase === 'result';
    const lost = new Set(st.lost || []);
    const outs = new Set(st.outs || []);
    const players = (st.in || [])
      .filter((s) => bySlot.has(s) && st.ps[s] && (here.has(s) || st.ps[s][0] <= 0))
      .map((s) => {
        const r = st.ps[s];
        return {
          face: face(bySlot.get(s), mine),
          slot: s,
          lives: r[0],
          out: r[0] <= 0,
          state: r[1] === 1 ? (result ? 'ok' : 'in') : r[1] ? (result ? 'miss' : 'in') : 'wait',
          place: r[2],
          best: r[3] || 0,
          lost: result && lost.has(s),
          fell: result && outs.has(s),
          gain: result && st.gained ? st.gained[s] || 0 : 0,
        };
      })
      .sort((a, b) => Number(a.out) - Number(b.out) || b.lives - a.lives || a.slot - b.slot);
    return {
      r: st.r,
      phase: st.phase,
      len: st.len,
      seq: unmaskSeq(st.sq, st.k),
      step: st.step,
      starts: st.starts,
      ends: st.ends,
      speed: speedOf(st),
      waiting,
      watching: !row && !waiting,
      lives: row ? row[0] : 0,
      maxLives: st.lv || 2,
      out: Boolean(row && row[0] <= 0),
      sent: Boolean(row && row[1] !== 0),
      right: Boolean(row && row[1] === 1),
      canPlay: st.phase === 'input' && Boolean(row) && row[0] > 0 && row[1] === 0,
      myGain: result && row && st.gained ? st.gained[mine] || 0 : 0,
      myLost: result && lost.has(mine),
      myOut: result && outs.has(mine),
      players,
      alive: players.filter((p) => !p.out).length,
    };
  },
};

export default memory;
