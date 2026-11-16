import { STYLES, DIFFS, SEED_MAX, styleById, diffById, songFor, lastNoteAt, notesBefore, boundFor, prefixMax, accuracy, gradeOf } from './beatchart.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';
import { award, roundAt, say, bump, prize, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'beatdrop';
export const MIX = 'mix';
export const READY_MS = 20000;
export const LEAD_MS = 4000;
export const END_GRACE_MS = 5000;
export const SHOW_MS = 9000;
export const LATE_MIN_MS = 15000;
export const PROG_SLACK = 1.5;
export const PROG_GAP_MS = 900;
export const DONE_EARLY_MS = 2000;
export const SKIP_SLACK = 3;
export const POINT_DIV = 20;
export const CLOSE_PCT = 0.03;
export const COMBO_PRIZE = 25;

export function songOfState(st) {
  if (!st || !Number.isInteger(st.seed)) return null;
  return songFor(st.seed, st.sty, st.df, st.len);
}

export function lineup(setting, count, random) {
  const ids = STYLES.map((s) => s.id);
  if (setting && setting !== MIX && ids.includes(setting)) return Array.from({ length: count }, () => setting);
  const out = [];
  while (out.length < count) out.push(...shuffle(ids, random));
  return out.slice(0, count);
}

function seedOf(random) {
  return 1 + Math.floor(random() * (SEED_MAX - 1));
}

function int(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : [];
}

function present(api) {
  return api.players().map((p) => p.slot);
}

function baseState(api, prev, i) {
  const ls = prev.ls;
  return {
    v: 1,
    n: (prev.n || 0) + 1,
    i,
    total: prev.total,
    ls,
    seed: seedOf(api.random),
    sty: ls[i] || ls[0],
    df: prev.df,
    len: prev.len,
    in: present(api),
    wait: [],
    rd: [],
    sc: {},
    hs: {},
    jt: {},
    res: null,
    note: null,
    at: null,
  };
}

function play(api, st, note = null) {
  const song = songOfState(st);
  const now = api.now();
  const at = now + LEAD_MS;
  const ends = at + Math.round(song.dur * 1000) + END_GRACE_MS;
  const here = present(api);
  const ins = inPlay(st).concat(Array.isArray(st.wait) ? st.wait : []).filter((s, i, a) => a.indexOf(s) === i);
  const next = { ...st, phase: 'play', in: ins.filter((s) => here.includes(s)).concat(here.filter((s) => !ins.includes(s))), wait: [], rd: [], sc: {}, hs: {}, jt: {}, at, starts: now, ends, note: note || st.note || null };
  api.put(KEY, next);
  api.setDeadline(ends);
}

function ready(api, st) {
  const now = api.now();
  const ends = now + READY_MS;
  api.put(KEY, { ...st, phase: 'ready', starts: now, ends });
  api.setDeadline(ends);
}

function rowsOf(api, st, song) {
  const slots = inPlay(st).concat(Object.keys(st.sc || {}).map(Number)).filter((s, i, a) => Number.isInteger(s) && a.indexOf(s) === i);
  const total = song ? song.notes.length : 0;
  return slots.map((s) => {
    const sc = Array.isArray(st.sc[s]) ? st.sc[s] : [0, 0, 0, 0];
    const h = Array.isArray(st.hs[s]) ? st.hs[s] : null;
    const done = sc[3] === 1 && Boolean(h);
    const counted = h ? h[0] + h[1] + h[2] + h[3] : 0;
    const fc = done && total > 0 && h[3] === 0 && h[4] === 0 && counted === total;
    const acc = h ? accuracy(h) : 0;
    return { s, sc: sc[0] || 0, c: sc[1] || 0, d: done ? 1 : 0, fc: fc ? 1 : 0, a: acc, gr: h ? gradeOf(acc, fc) : '-', h: h ? h.slice(0, 4) : null };
  });
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'play') return;
  const song = songOfState(st);
  const rows = rowsOf(api, st, song).sort((a, b) => b.sc - a.sc || b.a - a.a || a.s - b.s);
  const fx = funMem(api);
  rows.forEach((r, i) => {
    r.n = i > 0 && rows[i - 1].sc === r.sc ? rows[i - 1].n : i + 1;
    r.p = r.sc > 0 ? award(api, r.s, Math.round(r.sc / POINT_DIV)) : 0;
    if (r.fc) {
      bump(api, 'fc', r.s);
      say(api, 'hot', { slot: r.s });
      keep(api, `🎯 ${nameOf(api, r.s)} went full combo on ${styleById(st.sty).name}`, r.s, 4);
    }
    if (r.h) bump(api, 'perfect', r.s, r.h[0]);
    if (!fx.combo || r.c > fx.combo.n) fx.combo = { slot: r.s, n: r.c };
  });
  const top = rows.filter((r) => r.sc > 0);
  if (top.length >= 2 && top[0].sc - top[1].sc <= top[0].sc * CLOSE_PCT) {
    say(api, 'close', { slot: top[1].s, other: top[0].s });
    keep(api, `🥁 ${nameOf(api, top[0].s)} edged out ${nameOf(api, top[1].s)} by ${(top[0].sc - top[1].sc).toLocaleString('en-US')} points`, top[0].s, 3);
  }
  const best = rows.reduce((a, r) => (r.c > (a ? a.c : 0) ? r : a), null);
  if (best && best.c >= COMBO_PRIZE) keep(api, `🔥 ${nameOf(api, best.s)} strung together a ${best.c} note combo`, best.s, 2 + best.c / 100);
  const now = api.now();
  const ends = now + SHOW_MS;
  api.put(KEY, { ...st, phase: 'show', res: rows, sc: {}, hs: {}, jt: {}, rd: [], wait: [], starts: now, ends });
  api.setDeadline(ends);
}

function next(api, st) {
  if (st.i + 1 < st.total && api.players().length) {
    const nx = baseState(api, st, st.i + 1);
    roundAt(api, nx.i + 1, nx.total);
    return play(api, nx);
  }
  return api.finish();
}

function liveIn(api, st) {
  const here = present(api);
  return inPlay(st).filter((s) => here.includes(s));
}

function everyoneReady(api, st) {
  const live = liveIn(api, st);
  return live.length > 0 && live.every((s) => st.rd.includes(s));
}

function everyoneDone(api, st) {
  const live = liveIn(api, st);
  return live.length > 0 && live.every((s) => Array.isArray(st.sc[s]) && st.sc[s][3] === 1);
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot)) return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.phase === 'ready') {
    st.in.push(slot);
    return true;
  }
  if (st.phase !== 'play') return false;
  const now = api.now();
  if (st.ends - END_GRACE_MS - now >= LATE_MIN_MS) {
    st.in.push(slot);
    st.jt[slot] = Math.max(0, Math.round(now - st.at));
  } else st.wait.push(slot);
  return true;
}

function joinIfNew(api, st, slot) {
  if (inPlay(st).includes(slot)) return true;
  const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
  if (admitted) api.put(KEY, st);
  return inPlay(st).includes(slot);
}

export function checkProgress(song, songSec, a, joinSec = 0) {
  const s = int(a.s);
  const c = int(a.c);
  const j = int(a.j);
  if (s === null || c === null || j === null) return null;
  const due = notesBefore(song, songSec + PROG_SLACK);
  if (j > due || c > j) return null;
  const gone = notesBefore(song, joinSec - SKIP_SLACK);
  return [Math.min(s, prefixMax(Math.max(0, j - gone))), c, j, 0];
}

export function checkFinal(song, joinSec, a) {
  const vals = ['s', 'c', 'p', 'g', 'o', 'm', 'k'].map((k) => int(a[k]));
  if (vals.some((v) => v === null)) return null;
  const [s, c, p, g, o] = vals;
  let [, , , , , m, k] = vals;
  const total = song.notes.length;
  const hits = p + g + o;
  if (hits + m + k !== total || c > hits) return null;
  if (hits > total - notesBefore(song, joinSec - SKIP_SLACK)) return null;
  const skipMax = notesBefore(song, joinSec + SKIP_SLACK);
  if (k > skipMax) {
    m += k - skipMax;
    k = skipMax;
  }
  const score = Math.min(s, boundFor(p, g, o, c));
  return { sc: [score, c, total, 1], hs: [p, g, o, m, k] };
}

export function startState(api) {
  const total = Math.max(1, Math.min(5, Number(api.settings.songs) || 1));
  const ls = lineup(api.settings.style, total, api.random);
  const df = diffById(api.settings.difficulty).id;
  const len = [45, 60, 90].includes(Number(api.settings.length)) ? Number(api.settings.length) : 60;
  return { n: 0, total, ls, df, len };
}

const beatdrop = {
  id: 'beatdrop',
  name: 'Beat Drop',
  emoji: '🥁',
  category: 'quick',
  blurb: 'Notes fall down four lanes. Hit them on the line in time with the beat (D F J K or tap). Same song for everyone, highest score wins.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double'],
  settings: [
    { id: 'difficulty', label: 'Difficulty', type: 'choice', options: DIFFS.map((d) => ({ value: d.id, label: d.name })), default: 'normal' },
    { id: 'length', label: 'Song length', type: 'choice', options: [45, 60, 90].map((v) => ({ value: v, label: `${v} s` })), default: 60 },
    { id: 'songs', label: 'Songs', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
    { id: 'style', label: 'Music', type: 'choice', options: [{ value: MIX, label: 'Shuffle' }].concat(STYLES.map((s) => ({ value: s.id, label: s.name }))), default: MIX },
  ],

  start(api) {
    const st = baseState(api, startState(api), 0);
    roundAt(api, 1, st.total);
    ready(api, st);
  },

  intent(api, slot, action) {
    if (!action || typeof action.type !== 'string') return;
    const st = api.get(KEY);
    if (!st || action.n !== st.n) return;
    if (action.type === 'ready') {
      if (st.phase !== 'ready' || !joinIfNew(api, st, slot) || st.rd.includes(slot)) return;
      st.rd.push(slot);
      if (everyoneReady(api, st)) return play(api, st);
      api.put(KEY, st);
      return undefined;
    }
    if (st.phase !== 'play') return undefined;
    if (action.type !== 'prog' && action.type !== 'done') return undefined;
    if (!joinIfNew(api, st, slot)) return undefined;
    const cur = st.sc[slot];
    if (Array.isArray(cur) && cur[3] === 1) return undefined;
    const song = songOfState(st);
    const now = api.now();
    if (action.type === 'prog') {
      const mem = api.memory.lp || (api.memory.lp = {});
      if (mem[slot] && now - mem[slot] < PROG_GAP_MS) return undefined;
      const row = checkProgress(song, (now - st.at) / 1000, action, (Number(st.jt[slot]) || 0) / 1000);
      if (!row) return undefined;
      mem[slot] = now;
      st.sc[slot] = row;
      api.put(KEY, st);
      return undefined;
    }
    if (now < st.at + lastNoteAt(song) * 1000 - DONE_EARLY_MS) return undefined;
    const fin = checkFinal(song, (Number(st.jt[slot]) || 0) / 1000, action);
    if (!fin) return undefined;
    st.sc[slot] = fin.sc;
    st.hs[slot] = fin.hs;
    api.put(KEY, st);
    if (everyoneDone(api, st)) reveal(api);
    return undefined;
  },

  results(api) {
    const st = api.get(KEY);
    const fc = st && Array.isArray(st.res) ? st.res.filter((r) => r.fc).map((r) => r.s) : [];
    return { extra: fc.length ? { fullCombo: fc } : {} };
  },

  awards(api) {
    const fx = funMem(api);
    const c = fx.combo;
    return list(
      prize(api, 'fc', 'Full combo', '🎯', (n) => (n > 1 ? `${n} songs without a single miss` : 'Did not miss a single note'), 1),
      c && c.n >= COMBO_PRIZE ? { title: 'Combo king', emoji: '🔥', who: c.slot, why: `${c.n} notes in a row` } : null,
      prize(api, 'perfect', 'Perfect timing', '✨', (n) => `${n} perfect hits`, 20),
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'ready') return play(api, st);
    if (st.phase === 'play') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['ready', 'play', 'show'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      beatdrop.deadline(api);
      return true;
    }
    if (action.type === 'time' && st.phase !== 'play') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return beatdrop.start(api);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'play' && st.phase !== 'ready')) return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (st.phase === 'ready' && everyoneReady(api, st)) play(api, st);
    else if (st.phase === 'play' && everyoneDone(api, st)) reveal(api);
  },

  songOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    return st ? songOfState(st) : null;
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st || !Number.isInteger(st.seed)) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const song = songOfState(st);
    const sty = styleById(st.sty) || STYLES[0];
    const playing = mine !== null && inPlay(st).includes(mine);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const total = song.notes.length;
    const board = inPlay(st)
      .map((s) => {
        const p = bySlot.get(s);
        if (!p) return null;
        const sc = Array.isArray(st.sc && st.sc[s]) ? st.sc[s] : [0, 0, 0, 0];
        return { ...face(p, mine), slot: s, score: sc[0], combo: sc[1], pct: total ? Math.min(100, Math.round((sc[2] / total) * 100)) : 0, done: sc[3] === 1 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.slot - b.slot);
    const results = st.phase === 'show' && Array.isArray(st.res)
      ? st.res
          .map((r) => {
            const p = bySlot.get(r.s);
            return p ? { ...face(p, mine), slot: r.s, score: r.sc, combo: r.c, place: r.n, pts: r.p, fc: Boolean(r.fc), acc: r.a, grade: r.gr, hits: r.h, done: Boolean(r.d) } : null;
          })
          .filter(Boolean)
      : [];
    const readyBy = (st.rd || []).map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine));
    return {
      key: `${st.n}`,
      n: st.n,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      style: { id: sty.id, name: sty.name, emoji: sty.emoji, bpm: sty.bpm },
      diff: diffById(st.df).id,
      diffName: diffById(st.df).name,
      len: st.len,
      at: st.at,
      starts: st.starts,
      ends: st.ends,
      notes: total,
      songEnd: st.at === null ? null : st.at + Math.round(song.dur * 1000),
      note: st.note || null,
      playing,
      waiting,
      watching: !playing && !waiting,
      iReady: mine !== null && (st.rd || []).includes(mine),
      readyBy,
      readyCount: readyBy.length,
      players: inPlay(st).filter((s) => bySlot.has(s) && bySlot.get(s).present !== false).length,
      board,
      results,
      mine: results.find((r) => r.slot === mine) || null,
      last: st.i + 1 >= st.total,
    };
  },
};

export default beatdrop;
