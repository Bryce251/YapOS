import { mask, unmask } from './draw.js';
import { face } from './trivia.js';
import { KO_ROUND_CAP, SURVIVOR_POINTS, koSetting, koOn, koOut, koTotal, koModel } from './knockout.js';

export const KEY = 'reflex';
export const MIN_DELAY = 1500;
export const MAX_DELAY = 5000;
export const AMBER_MIN = 1000;
export const AMBER_MAX = 2800;
export const AMBER_GAP_MIN = 900;
export const AMBER_GAP_MAX = 2200;
export const FAKE_CHANCE = 0.45;
export const TAP_WINDOW = 3000;
export const MIN_WINDOW = 1500;
export const SHOW_MS = 4500;
export const CLOSE_MS = 12;
export const FAST_TAP = 260;
export const HL_KEEP = 3;
export const MIN_MS = 80;
export const MAX_MS = 1500;
export const SLOW_CAP = 9999;
export const LATE_GAP = 800;
export const SKEW_SLACK = 1500;
export const POINTS = Object.freeze([100, 70, 50, 30, 20]);
export const FLOOR_POINTS = 10;
export const KINDS = Object.freeze(['ok', 'slow', 'early', 'fooled', 'none']);

export function pointsFor(place) {
  return place < POINTS.length ? POINTS[place] : FLOOR_POINTS;
}

function between(random, lo, hi) {
  return Math.round(lo + random() * (hi - lo));
}

export function plan(random, fakeouts) {
  if (fakeouts && random() < FAKE_CHANCE) {
    const amber = between(random, AMBER_MIN, AMBER_MAX);
    return { amber, green: Math.min(MAX_DELAY, amber + between(random, AMBER_GAP_MIN, AMBER_GAP_MAX)) };
  }
  const green = between(random, MIN_DELAY, MAX_DELAY);
  return { amber: green, green };
}

export function greenOf(st) {
  return st.at + unmask(st.g, st.nonce);
}

export function amberOf(st) {
  const a = st.at + unmask(st.a, st.nonce);
  return a < greenOf(st) ? a : null;
}

export function rankRound(taps, slots) {
  const all = Array.from(new Set((slots || []).concat(Object.keys(taps || {}).map(Number)))).filter(Number.isInteger);
  const ok = all.filter((s) => taps[s] && taps[s].k === 'ok').sort((a, b) => taps[a].ms - taps[b].ms || a - b);
  const res = [];
  const gained = {};
  ok.forEach((s, i) => {
    const place = i > 0 && taps[ok[i - 1]].ms === taps[s].ms ? res[i - 1].n - 1 : i;
    const p = pointsFor(place);
    gained[s] = p;
    res.push({ s, k: 'ok', ms: taps[s].ms, n: place + 1, p });
  });
  const order = { slow: 0, fooled: 1, early: 2, none: 3 };
  const rest = all
    .filter((s) => !ok.includes(s))
    .map((s) => {
      const t = taps[s];
      const k = t && KINDS.includes(t.k) ? t.k : 'none';
      return k === 'slow' ? { s, k, ms: t.ms, n: 0, p: 0 } : { s, k, n: 0, p: 0 };
    })
    .sort((a, b) => order[a.k] - order[b.k] || (a.ms || 0) - (b.ms || 0) || a.s - b.s);
  return { res: res.concat(rest), gained };
}

export function fastestOf(best) {
  const rows = Object.entries(best || {})
    .map(([s, ms]) => [Number(s), Number(ms)])
    .filter(([s, ms]) => Number.isInteger(s) && Number.isFinite(ms) && ms >= 0);
  if (!rows.length) return [];
  const low = Math.min(...rows.map(([, ms]) => ms));
  return rows.filter(([, ms]) => ms === low).map(([s]) => s);
}

export function bestAfter(best, res) {
  const out = { ...(best || {}) };
  for (const r of res) if (r.k === 'ok' && (!(r.s in out) || r.ms < out[r.s])) out[r.s] = r.ms;
  return out;
}

function nonceOf(random) {
  return 1 + Math.floor(random() * 65534);
}

function say(api, kind, data) {
  if (api && typeof api.say === 'function') api.say(kind, data);
}

function give(api, slot, n) {
  const got = api.addPoints(slot, n);
  return Number.isFinite(got) ? got : n;
}

function round(api, prev, i, note) {
  const nonce = nonceOf(api.random);
  const times = plan(api.random, api.settings.fakeouts === 'on');
  const at = api.now();
  const green = at + times.green;
  const ends = green + TAP_WINDOW;
  const r = (prev.r || 0) + 1;
  const here = api.players().map((p) => p.slot);
  const al = prev.ko && Array.isArray(prev.al) ? prev.al : null;
  if (typeof api.round === 'function') {
    if (al) api.round(r, koTotal(r, al));
    else api.round(i + 1, prev.total);
  }
  api.memory.cur = { r, taps: {} };
  const st = {
    r,
    i,
    total: prev.total,
    fake: api.settings.fakeouts === 'on' ? 1 : 0,
    phase: 'wait',
    nonce,
    at,
    g: mask(times.green, nonce),
    a: mask(times.amber, nonce),
    in: al ? al.filter((s) => here.includes(s)) : here,
    wait: [],
    done: [],
    res: null,
    fk: 0,
    best: prev.best || {},
    note: note || null,
    starts: at,
    ends,
  };
  if (al) {
    st.ko = 1;
    st.al = al;
    st.ot = Array.isArray(prev.ot) ? prev.ot : [];
    st.kx = [];
  }
  if (prev.ju) st.ju = prev.ju;
  if (Array.isArray(prev.hl)) st.hl = prev.hl;
  api.put(KEY, st);
  api.setDeadline(ends);
}

function topOf(slots, pts) {
  const list = (slots || []).filter(Number.isInteger);
  if (!list.length) return undefined;
  const hi = Math.max(...list.map((s) => Number(pts[s]) || 0));
  return list.filter((s) => (Number(pts[s]) || 0) === hi);
}

function next(api, st) {
  if (st.ko) {
    const al = Array.isArray(st.al) ? st.al : [];
    if (al.length <= 1) return api.finish(al.slice());
    if ((st.r || 0) >= KO_ROUND_CAP) return api.finish(topOf(al, api.points()));
    return round(api, st, st.i + 1);
  }
  if (st.i + 1 < st.total) return round(api, st, st.i + 1);
  return api.finish();
}

function hlPush(list, x, w) {
  const text = x.length > 118 ? `${x.slice(0, 117)}…` : x;
  return (Array.isArray(list) ? list : [])
    .filter((h) => h.x !== text)
    .concat([{ x: text, w }])
    .sort((a, b) => b.w - a.w)
    .slice(0, HL_KEEP);
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'wait') return;
  const cur = api.memory.cur;
  const taps = cur && cur.r === st.r ? cur.taps : {};
  const { res, gained } = rankRound(taps, st.in);
  for (const [slot, pts] of Object.entries(gained)) {
    const got = give(api, Number(slot), pts);
    const row = res.find((x) => x.s === Number(slot));
    if (row) row.p = got;
  }
  api.memory.cur = null;
  const patch = {};
  const oks = res.filter((x) => x.k === 'ok');
  const prevBest = Object.values(st.best || {}).filter(Number.isFinite);
  const record = oks.length && (!prevBest.length || oks[0].ms < Math.min(...prevBest)) ? oks[0] : null;
  if (oks.length >= 2 && oks[1].ms - oks[0].ms <= CLOSE_MS) say(api, 'close', { slot: oks[1].s });
  else if (oks.length && oks[0].ms <= FAST_TAP) say(api, 'fast', { slot: oks[0].s });
  const jumped = res.filter((x) => x.k === 'early' || x.k === 'fooled');
  if (jumped.length) {
    const ju = { ...(st.ju || {}) };
    for (const x of jumped) ju[x.s] = (ju[x.s] || 0) + 1;
    patch.ju = ju;
  }
  let hl = st.hl;
  const fooled = res.filter((x) => x.k === 'fooled').length;
  if (fooled >= 2) hl = hlPush(hl, `🟡 ${fooled} people fell for the same fake-out in round ${st.i + 1}`, 2 + fooled);
  if (record && api.players().length > 1) hl = hlPush(hl, `⚡ ${api.nameOf(record.s)} set the record with a ${record.ms} ms tap`, 3);
  if (hl !== st.hl) patch.hl = hl;
  if (st.ko) {
    const al = (Array.isArray(st.al) ? st.al : []).filter(Number.isInteger);
    const order = rankRound(taps, al).res.map((x) => ({ s: x.s, ok: x.k === 'ok' }));
    const out = koOut(al, order);
    const left = al.filter((s) => !out.includes(s));
    patch.al = left;
    patch.kx = out;
    patch.ot = (Array.isArray(st.ot) ? st.ot : []).concat(out);
    for (const s of out) say(api, 'out', { slot: s });
    if (left.length === 1 && al.length > 1) patch.sv = give(api, left[0], SURVIVOR_POINTS);
  }
  const now = api.now();
  const ends = now + SHOW_MS;
  api.put(KEY, {
    ...st,
    ...patch,
    phase: 'show',
    res,
    fk: amberOf(st) !== null ? 1 : 0,
    best: bestAfter(st.best, res),
    wait: [],
    starts: now,
    ends,
  });
  api.setDeadline(ends);
}

function everyoneDone(api, st) {
  const live = api.players().map((p) => p.slot).filter((s) => st.in.includes(s));
  return live.every((s) => st.done.includes(s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'wait' || st.ko) return false;
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (greenOf(st) - api.now() >= LATE_GAP) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function record(api, st, action) {
  if (action.type === 'early') {
    const amber = amberOf(st);
    const fooled = action.on === 'amber' && amber !== null && api.now() >= amber - SKEW_SLACK;
    return { k: fooled ? 'fooled' : 'early' };
  }
  const ms = Number(action.ms);
  if (!Number.isFinite(ms) || ms < MIN_MS) return null;
  const since = api.now() - greenOf(st);
  if (since < -SKEW_SLACK || ms > since + SKEW_SLACK) return null;
  const n = Math.round(ms);
  return n > MAX_MS ? { k: 'slow', ms: Math.min(n, SLOW_CAP) } : { k: 'ok', ms: n };
}

export function startState(api) {
  const here = typeof api.players === 'function' ? api.players().map((p) => p.slot) : [];
  const total = Math.max(1, Number(api.settings.rounds) || 10);
  if (!koOn(api.settings, here.length)) return { r: 0, total, best: {} };
  return { r: 0, total: KO_ROUND_CAP, best: {}, ko: 1, al: here.slice(), ot: [] };
}

function bestOf(map, min, low) {
  let top = null;
  for (const [slot, n] of Object.entries(map || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !Number.isFinite(n) || !(low ? n >= 0 : n >= min)) continue;
    if (!top || (low ? n < top.n : n > top.n) || (n === top.n && s < top.slot)) top = { slot: s, n };
  }
  return top;
}

const reflex = {
  id: 'reflex',
  name: 'Reflex',
  emoji: '⚡',
  category: 'quick',
  blurb: 'Wait for green, then tap faster than everyone else. In a knockout, the slowest tapper each round is out.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double'],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    koSetting(),
    {
      id: 'fakeouts',
      label: 'Fake-outs',
      type: 'choice',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      default: 'on',
    },
  ],

  start(api) {
    round(api, startState(api), 0);
  },

  results(api) {
    const st = api.get(KEY);
    const fastest = st ? fastestOf(st.best) : [];
    const out = { extra: fastest.length ? { fastest } : {} };
    if (st && st.ko && Array.isArray(st.al) && st.al.length === 1) out.note = `🥊 ${api.nameOf(st.al[0])} won the knockout`;
    return out;
  },

  awards(api) {
    const st = api.get(KEY);
    if (!st) return [];
    const out = [];
    if (st.ko && Array.isArray(st.al) && st.al.length === 1) out.push({ emoji: '🥊', title: 'Last one standing', who: st.al[0], why: 'Outlasted everyone in the knockout' });
    const quick = bestOf(st.best, 0, true);
    if (quick) out.push({ emoji: '🐆', title: 'Fastest hands', who: quick.slot, why: `Best tap: ${quick.n} ms` });
    const eager = bestOf(st.ju, 2, false);
    if (eager) out.push({ emoji: '🐇', title: 'Too eager', who: eager.slot, why: `Jumped the gun ${eager.n} times` });
    return out;
  },

  highlights(api) {
    const st = api.get(KEY);
    return st && Array.isArray(st.hl) ? st.hl.map((x) => ({ text: x.x })) : [];
  },

  intent(api, slot, action) {
    if (!action || (action.type !== 'tap' && action.type !== 'early')) return;
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'wait' || !cur || cur.r !== st.r || action.r !== st.r) return;
    if (cur.taps[slot]) return;
    if (!st.in.includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!st.in.includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    const tap = record(api, st, action);
    if (!tap) return;
    cur.taps[slot] = tap;
    if (!st.done.includes(slot)) st.done.push(slot);
    api.put(KEY, st);
    if (everyoneDone(api, st)) reveal(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'wait') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'wait' && st.phase !== 'show')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'wait') reveal(api);
      else next(api, st);
      return true;
    }
    if (action.type === 'time') {
      let ends = api.shift(st.ends, action.ms);
      if (st.phase === 'wait') ends = Math.max(ends, greenOf(st) + MIN_WINDOW);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return reflex.start(api);
    if (st.phase === 'wait') return round(api, st, st.i, 'host');
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'wait') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneDone(api, st)) reveal(api);
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const people = snap.players.filter((p) => p.slot !== null);
    const bySlot = new Map(people.map((p) => [p.slot, p]));
    const waiting = mine !== null && st.wait.includes(mine);
    const watching = !waiting && (mine === null || !st.in.includes(mine));
    const show = st.phase === 'show';
    const res = show && Array.isArray(st.res) ? st.res : [];
    const fastest = res.length && res[0].k === 'ok' ? res[0].ms : null;
    const results = res
      .map((x) => {
        const p = bySlot.get(x.s);
        if (!p) return null;
        return { ...face(p, mine), slot: x.s, kind: x.k, ms: x.ms ?? null, place: x.n, pts: x.p, fastest: x.k === 'ok' && x.ms === fastest };
      })
      .filter(Boolean);
    const best = Object.entries(st.best || {})
      .map(([s, ms]) => ({ slot: Number(s), ms }))
      .sort((a, b) => a.ms - b.ms || a.slot - b.slot)
      .map((x, i) => {
        const p = bySlot.get(x.slot);
        return p ? { ...face(p, mine), slot: x.slot, ms: x.ms, place: i + 1 } : null;
      })
      .filter(Boolean);
    const mineRes = results.find((x) => x.slot === mine) || null;
    const ko = koModel(st, mine, bySlot, face);
    return {
      ko: ko ? { ...ko, out: show ? ko.out : [] } : null,
      survivor: show && st.sv ? st.sv : 0,
      key: `${st.r}`,
      r: st.r,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      fakeouts: Boolean(st.fake),
      greenAt: greenOf(st),
      amberAt: amberOf(st),
      starts: st.starts,
      ends: st.ends,
      waiting,
      watching,
      canPlay: st.phase === 'wait' && !waiting && !watching,
      done: st.done.length,
      players: st.in.length,
      doneBy: st.done.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      iDone: mine !== null && st.done.includes(mine),
      note: st.note,
      wasFake: show && Boolean(st.fk),
      results,
      best,
      mine: mineRes,
      myBest: mine !== null && st.best && st.best[mine] !== undefined ? st.best[mine] : null,
      last: ko ? Boolean(ko.champ) || st.r >= KO_ROUND_CAP : st.i + 1 >= st.total,
    };
  },
};

export default reflex;
