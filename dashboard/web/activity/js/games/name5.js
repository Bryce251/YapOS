import { CATEGORIES, EASY_LETTERS, HARD_LETTERS } from '../../data/name5.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';
import { cleanText, cleanShared, hidesWords, plainKey } from '../text.js';
import { award, roundAt, say, streak, bump, prize, bestStreak, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'name5';
export const ANS = 'name5.a.';
export const VOTES = 'name5.v';
export const SLOTS = 5;
export const ANSWER_MAX = 30;
export const GRACE_MS = 1200;
export const RUSH_MS = 10000;
export const REVEAL_MS = 8000;
export const LATE_MIN_MS = 10000;
export const HOST_MIN_MS = 8000;
export const UNIQUE_POINTS = 100;
export const SHARED_POINTS = 50;
export const VOTE_CAP = 30;
export const LONE_VETO_MAX = 2;

export const OK = 0;
export const BLANK = 1;
export const LETTER = 2;
export const HIDDEN = 3;

export function normAnswer(text) {
  let k = plainKey(text).replace(/ /g, '');
  if (k.length > 4 && k.endsWith('ies')) k = `${k.slice(0, -3)}y`;
  else if (k.length > 4 && /(s|x|z|ch|sh)es$/.test(k)) k = k.slice(0, -2);
  else if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) k = k.slice(0, -1);
  return k;
}

export function startsWith(text, letter) {
  const k = plainKey(text);
  return Boolean(k) && typeof letter === 'string' && k[0] === letter.toLowerCase();
}

export function judge(raw, letter) {
  const text = cleanText(typeof raw === 'string' ? raw : '', ANSWER_MAX);
  if (!text || !plainKey(text)) return { a: '', k: BLANK };
  if (hidesWords(text)) return { a: '', k: HIDDEN };
  const clean = cleanShared(text, ANSWER_MAX);
  if (!clean) return { a: '', k: HIDDEN };
  return { a: clean, k: startsWith(clean, letter) ? OK : LETTER };
}

export function dealLetter(used, hard, random = Math.random) {
  const all = hard ? EASY_LETTERS.concat(HARD_LETTERS) : EASY_LETTERS.slice();
  const seen = new Set(String(used || '').split(''));
  let pool = all.filter((l) => !seen.has(l));
  if (!pool.length) pool = all;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

export function dealCats(used, random = Math.random) {
  const seen = new Set(Array.isArray(used) ? used : []);
  let pool = CATEGORIES.filter((c) => !seen.has(c.id));
  if (pool.length < SLOTS) pool = CATEGORIES.slice();
  return shuffle(pool, random).slice(0, SLOTS);
}

export function needed(voters) {
  return Math.floor(Math.max(0, voters) / 2) + 1;
}

export function scoreRound(sheets, votes, voters) {
  const vetoed = {};
  const valid = {};
  for (const [slot, sheet] of Object.entries(sheets)) {
    vetoed[slot] = [];
    valid[slot] = [];
    const v = Math.max(0, (voters && voters[slot]) || 0);
    let lone = 0;
    for (let c = 0; c < SLOTS; c += 1) {
      const ok = sheet.k[c] === OK;
      const n = ok ? ((votes && votes[`${slot}.${c}`]) || []).length : 0;
      let out = ok && v > 0 && n >= needed(v);
      if (out && v === 1) {
        lone += 1;
        if (lone > LONE_VETO_MAX) out = false;
      }
      vetoed[slot].push(out ? 1 : 0);
      valid[slot].push(ok && !out);
    }
  }
  const counts = [];
  for (let c = 0; c < SLOTS; c += 1) {
    const m = new Map();
    for (const [slot, sheet] of Object.entries(sheets)) {
      if (!valid[slot][c]) continue;
      const key = normAnswer(sheet.a[c]);
      m.set(key, (m.get(key) || 0) + 1);
    }
    counts.push(m);
  }
  const out = {};
  for (const [slot, sheet] of Object.entries(sheets)) {
    const p = [];
    const same = [];
    for (let c = 0; c < SLOTS; c += 1) {
      if (!valid[slot][c]) {
        p.push(0);
        same.push(0);
        continue;
      }
      const n = counts[c].get(normAnswer(sheet.a[c])) || 1;
      p.push(n > 1 ? SHARED_POINTS : UNIQUE_POINTS);
      same.push(n);
    }
    out[slot] = { p, x: vetoed[slot], same, total: p.reduce((a, b) => a + b, 0) };
  }
  return out;
}

function present(api) {
  return api.players().map((p) => p.slot);
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : [];
}

function fresh(api, st) {
  const cur = api.memory.cur;
  return cur && cur.n === st.n ? cur : null;
}

function sheetOf(api, slot, n) {
  const s = api.get(`${ANS}${slot}`);
  return s && s.r === n && Array.isArray(s.a) && Array.isArray(s.k) ? s : null;
}

function clearSheets(api, keep) {
  const live = new Set(keep.map((s) => `${ANS}${s}`));
  for (const k of api.keys()) if (k.startsWith(ANS) && !live.has(k)) api.put(k, null);
}

function round(api, i, total) {
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const ul = prev && typeof prev.ul === 'string' ? prev.ul : '';
  const uc = prev && Array.isArray(prev.uc) ? prev.uc : [];
  const letter = dealLetter(ul, Boolean(api.settings.hard), api.random);
  const cats = dealCats(uc, api.random);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { n, ans: {} };
  roundAt(api, i + 1, total);
  const allUsed = uc.concat(cats.map((c) => c.id));
  api.put(KEY, {
    v: 1,
    n,
    i,
    total,
    phase: 'write',
    l: letter,
    cats: cats.map((c) => ({ id: c.id, n: c.name, e: c.emoji })),
    in: present(api),
    wait: [],
    done: [],
    ok: [],
    rush: null,
    rq: 0,
    note: null,
    gained: {},
    ul: (ul.length >= EASY_LETTERS.length ? '' : ul) + letter,
    uc: allUsed.length > CATEGORIES.length - SLOTS ? cats.map((c) => c.id) : allUsed,
    starts,
    ends,
  });
  api.setDeadline(ends + GRACE_MS);
}

function next(api, st) {
  if (st.i + 1 < st.total && api.players().length) return round(api, st.i + 1, st.total);
  return api.finish();
}

function voterCounts(api, st, slots) {
  const live = new Set(present(api));
  const voting = inPlay(st).filter((s) => live.has(s));
  const out = {};
  for (const s of slots) out[s] = voting.filter((x) => x !== s).length;
  return out;
}

function review(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write') return;
  const cur = fresh(api, st);
  const wrote = [];
  let anyOk = 0;
  for (const slot of inPlay(st)) {
    const raw = cur && Array.isArray(cur.ans[slot]) ? cur.ans[slot] : [];
    const a = [];
    const k = [];
    for (let c = 0; c < SLOTS; c += 1) {
      const j = judge(raw[c], st.l);
      a.push(j.a);
      k.push(j.k);
      if (j.k === OK) anyOk += 1;
    }
    if (k.every((x) => x === BLANK)) continue;
    api.put(`${ANS}${slot}`, { r: st.n, s: slot, a, k });
    wrote.push(slot);
  }
  clearSheets(api, wrote);
  api.memory.cur = null;
  api.memory.vc = {};
  api.put(VOTES, { r: st.n, v: {} });
  const voters = present(api).filter((s) => inPlay(st).includes(s));
  if (!anyOk || voters.length < 2) {
    api.put(KEY, { ...st, phase: 'review', ok: [], starts: api.now(), ends: api.now() });
    return reveal(api);
  }
  const starts = api.now();
  const ends = starts + api.settings.review * 1000;
  api.put(KEY, { ...st, phase: 'review', ok: [], starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'review') return;
  const sheets = {};
  for (const slot of inPlay(st)) {
    const s = sheetOf(api, slot, st.n);
    if (s) sheets[slot] = s;
  }
  const vs = api.get(VOTES);
  const votes = vs && vs.r === st.n && vs.v ? vs.v : {};
  const scored = scoreRound(sheets, votes, voterCounts(api, st, Object.keys(sheets).map(Number)));
  const gained = {};
  let top = 0;
  for (const [slot, r] of Object.entries(scored)) {
    const s = Number(slot);
    const sheet = sheets[slot];
    api.put(`${ANS}${slot}`, { ...sheet, p: r.p, x: r.x, same: r.same });
    if (r.total > 0) gained[slot] = award(api, s, r.total);
    top = Math.max(top, r.total);
    let uniq = 0;
    for (let c = 0; c < SLOTS; c += 1) {
      if (r.p[c] === UNIQUE_POINTS) uniq += 1;
      if (r.p[c] === SHARED_POINTS) bump(api, 'shared', s);
      if (r.x[c]) {
        bump(api, 'vetoed', s);
        const cat = st.cats[c];
        const n = (votes[`${slot}.${c}`] || []).length;
        if (cat && sheet.a[c]) keep(api, `${nameOf(api, s)} swore "${sheet.a[c]}" counts as ${cat.n.toLowerCase()}`, s, 1 + n);
      }
    }
    if (uniq) bump(api, 'unique', s, uniq);
    if (uniq === SLOTS) {
      bump(api, 'perfect', s);
      say(api, 'custom', { text: `🖐️ ${nameOf(api, s)} got all five, and nobody else thought of any of them!` });
    }
  }
  const tops = Object.entries(scored).filter(([, r]) => top > 0 && r.total === top).map(([s]) => Number(s));
  for (const s of Object.keys(scored).map(Number)) streak(api, s, tops.includes(s));
  for (let c = 0; c < SLOTS; c += 1) {
    const groups = new Map();
    for (const [slot, r] of Object.entries(scored)) {
      if (r.p[c] !== SHARED_POINTS) continue;
      const key = normAnswer(sheets[slot].a[c]);
      if (!groups.has(key)) groups.set(key, { text: sheets[slot].a[c], who: Number(slot), n: 0 });
      groups.get(key).n += 1;
    }
    for (const g of groups.values()) if (g.n >= 3) keep(api, `${g.n} people all said "${g.text}" for ${st.cats[c].n.toLowerCase()}`, g.who, g.n);
  }
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', gained, starts, ends });
  api.setDeadline(ends);
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'write') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function everyone(api, st, list) {
  const live = present(api).filter((s) => inPlay(st).includes(s));
  return live.length > 0 && live.every((s) => list.includes(s));
}

function cleanSheet(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (let c = 0; c < SLOTS; c += 1) out.push(cleanText(typeof raw[c] === 'string' ? raw[c] : '', ANSWER_MAX));
  return out;
}

function save(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write' || action.n !== st.n) return;
  if (api.now() > st.ends + GRACE_MS) return;
  const cur = fresh(api, st);
  const sheet = cleanSheet(action.a);
  if (!cur || !sheet) return;
  let changed = false;
  if (!inPlay(st).includes(slot)) {
    const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
    if (!inPlay(st).includes(slot)) {
      if (admitted) api.put(KEY, st);
      return;
    }
    changed = true;
  }
  cur.ans[slot] = sheet;
  if (action.done === true && !st.done.includes(slot)) {
    st.done.push(slot);
    changed = true;
    const full = sheet.every((x) => x);
    if (full && api.settings.rush && st.rush === null && st.ends - api.now() > RUSH_MS && inPlay(st).length > 1) {
      st.rush = slot;
      st.ends = api.now() + RUSH_MS;
      api.setDeadline(st.ends + GRACE_MS);
      bump(api, 'rush', slot);
      say(api, 'custom', { text: `⏱️ ${nameOf(api, slot)} filled all five! Everyone else has 10 seconds.` });
    }
  }
  if (changed) api.put(KEY, st);
  if (everyone(api, st, st.done)) review(api);
}

function veto(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'review' || action.n !== st.n) return;
  const s = action.s;
  const c = action.c;
  if (!Number.isInteger(s) || !Number.isInteger(c) || c < 0 || c >= SLOTS || s === slot) return;
  if (!inPlay(st).includes(slot)) return;
  const sheet = sheetOf(api, s, st.n);
  if (!sheet || sheet.k[c] !== OK) return;
  const vc = api.memory.vc || (api.memory.vc = {});
  if ((vc[slot] || 0) >= VOTE_CAP) return;
  const vs = api.get(VOTES);
  const v = vs && vs.r === st.n && vs.v ? vs.v : {};
  const key = `${s}.${c}`;
  const now = Array.isArray(v[key]) ? v[key] : [];
  const has = now.includes(slot);
  const on = action.on !== false;
  if (on === has) return;
  if (on && voterCounts(api, st, [s])[s] <= 1) {
    let mine = 0;
    for (let x = 0; x < SLOTS; x += 1) if (Array.isArray(v[`${s}.${x}`]) && v[`${s}.${x}`].includes(slot)) mine += 1;
    if (mine >= LONE_VETO_MAX) return;
  }
  vc[slot] = (vc[slot] || 0) + 1;
  const after = on ? now.concat([slot]) : now.filter((x) => x !== slot);
  if (after.length) v[key] = after;
  else delete v[key];
  api.put(VOTES, { r: st.n, v });
}

function looksGood(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'review' || action.n !== st.n) return;
  if (!inPlay(st).includes(slot) || st.ok.includes(slot)) return;
  st.ok.push(slot);
  api.put(KEY, st);
  if (everyone(api, st, st.ok)) reveal(api);
}

const name5 = {
  id: 'namefive',
  name: 'Name 5',
  emoji: '🖐️',
  category: 'words',
  blurb: 'One letter, five categories, one clock. Think of answers nobody else will, because matches score less.',
  minPlayers: 1,
  keys: [KEY, VOTES],
  prefixes: [ANS],
  cards: ['swap', 'double'],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [2, 3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
    { id: 'timer', label: 'Time to write', type: 'choice', options: [30, 45, 60, 90].map((v) => ({ value: v, label: `${v} s` })), default: 60 },
    { id: 'review', label: 'Time to check', type: 'choice', options: [15, 25, 40].map((v) => ({ value: v, label: `${v} s` })), default: 25 },
    { id: 'rush', label: '⏱️ First to finish starts a 10 s countdown', type: 'toggle', default: true, fun: true },
    { id: 'hard', label: 'Hard letters (Q, U, V, X, Y, Z)', type: 'toggle', default: false },
  ],

  start(api) {
    clearSheets(api, []);
    round(api, 0, api.settings.rounds);
  },

  intent(api, slot, action) {
    if (!action || typeof action.type !== 'string') return;
    if (action.type === 'save') save(api, slot, action);
    else if (action.type === 'veto') veto(api, slot, action);
    else if (action.type === 'ok') looksGood(api, slot, action);
  },

  awards(api) {
    const hot = bestStreak(api, 2);
    return list(
      prize(api, 'perfect', 'Full hand', '🖐️', (n) => (n > 1 ? `${n} perfect rounds` : 'Five answers nobody else had'), 1),
      prize(api, 'unique', 'Original thinker', '💡', (n) => `${n} answers nobody else thought of`, 4),
      prize(api, 'shared', 'Great minds', '🤝', (n) => `Matched someone ${n} times`, 3),
      prize(api, 'rush', 'Quick draw', '⏱️', (n) => (n > 1 ? `Finished first ${n} times` : 'Finished first and started the countdown')),
      prize(api, 'vetoed', 'Nice try', '🙈', (n) => `${n} answers voted out`, 2),
      hot ? { title: 'On a roll', emoji: '🔥', who: hot.slots, why: `Top of ${hot.n} rounds in a row` } : null,
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'write') return review(api);
    if (st.phase === 'review') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st) return false;
    if (action.type === 'skip') {
      name5.deadline(api);
      return true;
    }
    if (action.type === 'time') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(st.phase === 'write' ? ends + GRACE_MS : ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return name5.start(api);
    if (st.phase === 'write' && !fresh(api, st)) {
      api.memory.cur = { n: st.n, ans: {} };
      const ends = Math.max(st.ends, api.now() + HOST_MIN_MS);
      api.put(KEY, { ...st, rq: (st.rq || 0) + 1, note: 'host', ends });
      api.setDeadline(ends + GRACE_MS);
      return undefined;
    }
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
    if (st.phase === 'write') {
      let added = false;
      for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
      if (added) api.put(KEY, st);
      if (everyone(api, st, st.done)) review(api);
    } else if (st.phase === 'review' && everyone(api, st, st.ok)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || typeof st.l !== 'string' || !Array.isArray(st.cats)) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const faceOf = (s) => (bySlot.get(s) ? face(bySlot.get(s), mine) : null);
    const playing = mine !== null && inPlay(st).includes(mine);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const iDone = mine !== null && (st.done.includes(mine) || (local.n === st.n && local.done === true));
    const sheets = [];
    if (st.phase !== 'write') {
      for (const s of inPlay(st)) {
        const sh = snap.state[`${ANS}${s}`];
        if (sh && sh.r === st.n && Array.isArray(sh.a) && Array.isArray(sh.k) && bySlot.has(s)) sheets.push(sh);
      }
      sheets.sort((a, b) => a.s - b.s);
    }
    const vs = snap.state[VOTES];
    const votes = vs && vs.r === st.n && vs.v ? vs.v : {};
    const live = inPlay(st).filter((s) => bySlot.has(s) && bySlot.get(s).present);
    const shown = st.phase === 'reveal';
    const grid = st.cats.map((cat, c) => {
      const groups = new Map();
      for (const sh of sheets) if (sh.k[c] === OK) groups.set(normAnswer(sh.a[c]), (groups.get(normAnswer(sh.a[c])) || 0) + 1);
      return {
        c,
        name: cat.n,
        emoji: cat.e,
        rows: sheets.map((sh) => {
          const who = sh.s;
          const n = Array.isArray(votes[`${who}.${c}`]) ? votes[`${who}.${c}`].length : 0;
          const voters = live.filter((x) => x !== who).length;
          const code = sh.k[c];
          return {
            who: faceOf(who),
            slot: who,
            text: sh.a[c] || '',
            code,
            mine: who === mine,
            votes: n,
            need: needed(voters),
            iVoted: mine !== null && Array.isArray(votes[`${who}.${c}`]) && votes[`${who}.${c}`].includes(mine),
            canVote: st.phase === 'review' && playing && who !== mine && code === OK,
            shared: code === OK && (groups.get(normAnswer(sh.a[c])) || 0) > 1,
            pts: shown && Array.isArray(sh.p) ? sh.p[c] || 0 : null,
            vetoed: shown && Array.isArray(sh.x) ? Boolean(sh.x[c]) : false,
          };
        }),
      };
    });
    const mineSheet = sheets.find((sh) => sh.s === mine) || null;
    return {
      phase: st.phase,
      n: st.n,
      number: st.i + 1,
      total: st.total,
      letter: st.l,
      cats: st.cats.map((c) => ({ name: c.n, emoji: c.e })),
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      rq: st.rq || 0,
      playing,
      waiting,
      watching: !playing && !waiting,
      canWrite: st.phase === 'write' && playing && !iDone,
      iDone,
      done: st.done.length,
      players: live.length || inPlay(st).length,
      doneBy: st.done.map(faceOf).filter(Boolean),
      rush: st.rush !== null && st.rush !== undefined ? faceOf(st.rush) : null,
      grid,
      okCount: Array.isArray(st.ok) ? st.ok.length : 0,
      iOk: mine !== null && Array.isArray(st.ok) && st.ok.includes(mine),
      canOk: st.phase === 'review' && playing && !(Array.isArray(st.ok) && st.ok.includes(mine)),
      myTotal: shown && mineSheet && Array.isArray(mineSheet.p) ? mineSheet.p.reduce((a, b) => a + b, 0) : 0,
      myGain: shown && st.gained && mine !== null ? st.gained[mine] || 0 : 0,
      empty: st.phase !== 'write' && !sheets.length,
    };
  },
};

export default name5;
