import { FACTS, factById, BLANK } from '../../data/bluff.js';
import { shuffle } from '../engine.js';
import { cleanShared, closeEnough, plainKey } from '../text.js';
import { seal, unseal, chunk } from './hottakes.js';
import { face } from './trivia.js';

export { seal, unseal };

export const KEY = 'bluff';
export const OPTION_PREFIX = 'bluff.';
export const FAKE_MAX = 40;
export const PICK_MS = 30000;
export const REVEAL_BASE_MS = 7000;
export const REVEAL_STEP_MS = 700;
export const REVEAL_MAX_MS = 15000;
export const TRUTH_POINTS = 100;
export const FOOL_POINTS = 50;
export const LATE_MIN_MS = 10000;

export function optionKey(i) {
  return `${OPTION_PREFIX}${i}`;
}

export function buildDeck(count, random = Math.random) {
  return shuffle(FACTS, random)
    .slice(0, Math.max(1, count))
    .map((f) => f.id);
}

export function revealMs(count) {
  return Math.min(REVEAL_MAX_MS, REVEAL_BASE_MS + REVEAL_STEP_MS * Math.max(0, count));
}

export function factParts(text) {
  const t = String(text || '');
  const at = t.indexOf(BLANK);
  if (at < 0) return { before: t, after: '' };
  return { before: t.slice(0, at), after: t.slice(at + BLANK.length) };
}

export function isTruth(fact, text) {
  if (!fact) return false;
  return closeEnough(text, [fact.a].concat(fact.alts || []));
}

export function groupFakes(fakes) {
  const groups = [];
  const byKey = new Map();
  for (const [slot, text] of Object.entries(fakes || {})) {
    const k = plainKey(text) || text.toLowerCase();
    let g = byKey.get(k);
    if (!g) {
      g = { text, owners: [] };
      byKey.set(k, g);
      groups.push(g);
    }
    g.owners.push(Number(slot));
  }
  for (const g of groups) g.owners.sort((a, b) => a - b);
  return groups;
}

export function tally(owners, truth, picks) {
  const gained = {};
  const by = {};
  for (const id of Object.keys(owners)) by[id] = [];
  by[truth] = by[truth] || [];
  for (const [slot, id] of Object.entries(picks || {})) {
    if (by[id] === undefined) continue;
    by[id].push(Number(slot));
  }
  for (const slot of by[truth]) gained[slot] = (gained[slot] || 0) + TRUTH_POINTS;
  for (const [id, list] of Object.entries(owners)) {
    if (Number(id) === truth) continue;
    const fooled = by[id].length;
    if (!fooled) continue;
    for (const o of list) gained[o] = (gained[o] || 0) + FOOL_POINTS * fooled;
  }
  const res = Object.keys(by)
    .map(Number)
    .map((id) => [id, id === truth ? [] : (owners[id] || []).slice(), by[id].sort((a, b) => a - b), id === truth ? 1 : 0])
    .sort((x, y) => y[3] - x[3] || y[2].length - x[2].length || x[0] - y[0]);
  return { res, gained };
}

function clearOptions(api) {
  for (const k of api.keys()) if (k.startsWith(OPTION_PREFIX)) api.put(k, null);
}

function liveSlots(api) {
  return api.players().map((p) => p.slot);
}

function inPlay(api, st) {
  const live = liveSlots(api);
  return Array.isArray(st.in) ? live.filter((s) => st.in.includes(s)) : live;
}

function ask(api, deck, i, note) {
  const f = factById(deck[i]);
  if (!f) return next(api, deck, i);
  clearOptions(api);
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const nonce = 1 + Math.floor(api.random() * 65535);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { n, fakes: {}, owners: null, truth: null, picks: {} };
  api.put(KEY, {
    v: 1,
    deck,
    i,
    total: deck.length,
    n,
    nonce,
    phase: 'write',
    f: { id: f.id, t: f.t },
    in: liveSlots(api),
    wait: [],
    done: [],
    picked: [],
    count: 0,
    chunks: 0,
    truth: null,
    answer: null,
    res: null,
    gained: {},
    lost: false,
    note: note || null,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, deck, i) {
  if (i + 1 < deck.length && api.players().length) return ask(api, deck, i + 1);
  clearOptions(api);
  return api.finish();
}

function fresh(api, st) {
  const cur = api.memory.cur;
  return cur && cur.n === st.n ? cur : null;
}

function toReveal(api, st, extra) {
  const f = factById(st.f.id);
  const ends = api.now() + revealMs(st.count);
  api.put(KEY, { ...st, phase: 'reveal', answer: f ? f.a : null, starts: api.now(), ends, ...extra });
  api.setDeadline(ends);
}

function writeOptions(api, list) {
  const parts = chunk(list);
  parts.forEach((part, i) => api.put(optionKey(i), part));
  return parts.length;
}

function toPick(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write') return;
  const f = factById(st.f.id);
  const cur = fresh(api, st);
  const groups = groupFakes(cur ? cur.fakes : {});
  if (!f || !groups.length) {
    api.memory.cur = null;
    const list = f ? [[0, f.a]] : [];
    const chunks = writeOptions(api, list);
    return toReveal(api, { ...st, wait: [], count: list.length, chunks }, { truth: f ? 0 : null, res: f ? [[0, [], [], 1]] : [], gained: {}, note: 'nofakes' });
  }
  const order = shuffle(groups.map((g) => ({ text: g.text, owners: g.owners })).concat([{ text: f.a, owners: null }]), api.random);
  const owners = {};
  let truth = 0;
  const list = order.map((o, id) => {
    if (o.owners) owners[id] = o.owners;
    else truth = id;
    return [id, o.text];
  });
  cur.owners = owners;
  cur.truth = truth;
  cur.picks = {};
  cur.fakes = {};
  const chunks = writeOptions(api, list);
  const starts = api.now();
  const ends = starts + PICK_MS;
  const wait = Array.isArray(st.wait) ? st.wait : [];
  const joined = (Array.isArray(st.in) ? st.in : []).concat(wait.filter((s) => !(st.in || []).includes(s)));
  const after = { ...st, phase: 'pick', in: joined, wait: [], count: list.length, chunks, picked: [], note: null, starts, ends };
  api.put(KEY, after);
  api.setDeadline(ends);
  if (allPicked(api, after)) reveal(api);
  return undefined;
}

function ownedBy(cur, slot) {
  return Object.keys(cur.owners || {}).filter((id) => cur.owners[id].includes(slot)).map(Number);
}

function pickers(api, st, cur) {
  const live = inPlay(api, st);
  if (!cur || !cur.owners) return live;
  return live.filter((s) => st.count - ownedBy(cur, s).length > 0);
}

function allWritten(api, st) {
  const live = inPlay(api, st);
  return live.length > 0 && live.every((s) => st.done.includes(s));
}

function allPicked(api, st) {
  const need = pickers(api, st, fresh(api, st));
  return need.every((s) => st.picked.includes(s));
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'pick') return;
  const cur = fresh(api, st);
  if (!cur || !cur.owners) {
    api.memory.cur = null;
    const f = factById(st.f.id);
    const opts = optionsFrom((k) => api.get(k), st);
    const t = f ? opts.find((o) => o.text === f.a) : null;
    return toReveal(api, st, { truth: t ? t.id : null, res: null, gained: {}, lost: true, note: 'host' });
  }
  const { res, gained } = tally(cur.owners, cur.truth, cur.picks);
  for (const [slot, pts] of Object.entries(gained)) api.addPoints(Number(slot), pts);
  api.memory.cur = null;
  return toReveal(api, st, { truth: cur.truth, res, gained, note: null });
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || (st.phase !== 'write' && st.phase !== 'pick')) return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot)) return false;
  if (st.phase === 'pick') {
    st.in.push(slot);
    st.wait = st.wait.filter((s) => s !== slot);
    return true;
  }
  if (st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function ensureIn(api, st, slot) {
  if (st.in.includes(slot)) return true;
  if (!api.players().some((p) => p.slot === slot)) return false;
  if (admit(api, st, slot)) api.put(KEY, st);
  return st.in.includes(slot);
}

function onFake(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write' || action.n !== st.n) return;
  const cur = fresh(api, st);
  if (!cur || cur.fakes[slot] !== undefined) return;
  if (!ensureIn(api, st, slot)) return;
  const text = cleanShared(unseal(action.code, st.nonce), FAKE_MAX);
  if (!text || isTruth(factById(st.f.id), text)) return;
  cur.fakes[slot] = text;
  if (!st.done.includes(slot)) st.done.push(slot);
  api.put(KEY, st);
  if (allWritten(api, st)) toPick(api);
}

function onPick(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'pick' || action.n !== st.n || !Number.isInteger(action.id)) return;
  const cur = fresh(api, st);
  if (!cur || !cur.owners || cur.picks[slot] !== undefined) return;
  if (action.id < 0 || action.id >= st.count) return;
  if (cur.owners[action.id] && cur.owners[action.id].includes(slot)) return;
  if (!ensureIn(api, st, slot)) return;
  cur.picks[slot] = action.id;
  if (!st.picked.includes(slot)) st.picked.push(slot);
  api.put(KEY, st);
  if (allPicked(api, st)) reveal(api);
}

export function optionsFrom(read, st) {
  const out = [];
  for (let i = 0; i < (st.chunks || 0); i += 1) {
    const part = read(optionKey(i));
    if (Array.isArray(part)) for (const row of part) if (Array.isArray(row) && Number.isInteger(row[0]) && typeof row[1] === 'string') out.push({ id: row[0], text: row[1] });
  }
  return out;
}

export function fakeRef(n, nonce, id) {
  return `bluff.${n}.${nonce}.${id}`;
}

const bluff = {
  id: 'bluff',
  name: 'Bluff',
  emoji: '🃏',
  category: 'quiz',
  blurb: 'Write a fake answer to a weird true fact, then spot the real one. Fool your friends for points.',
  minPlayers: 3,
  keys: [KEY],
  prefixes: [OPTION_PREFIX],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [5, 7, 10].map((v) => ({ value: v, label: String(v) })), default: 5 },
    { id: 'timer', label: 'Time to write', type: 'choice', options: [45, 60, 90].map((v) => ({ value: v, label: `${v} s` })), default: 60 },
  ],

  start(api) {
    ask(api, buildDeck(api.settings.rounds, api.random), 0);
  },

  intent(api, slot, action) {
    if (action.type === 'fake') onFake(api, slot, action);
    else if (action.type === 'pick') onPick(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'write') return toPick(api);
    if (st.phase === 'pick') return reveal(api);
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['write', 'pick', 'reveal'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      bluff.deadline(api);
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

  texts(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'pick' && st.phase !== 'reveal')) return [];
    const authors = {};
    if (st.phase === 'pick') {
      const cur = fresh(api, st);
      if (cur && cur.owners) for (const [id, list] of Object.entries(cur.owners)) authors[id] = list[0];
    } else if (Array.isArray(st.res)) {
      for (const row of st.res) if (Array.isArray(row) && Array.isArray(row[1]) && row[1].length) authors[row[0]] = row[1][0];
    }
    const context = st.f && st.f.t ? `Fact: ${st.f.t}` : null;
    return optionsFrom((k) => api.get(k), st)
      .filter((o) => Number.isInteger(authors[o.id]))
      .map((o) => ({ r: fakeRef(st.n, st.nonce, o.id), author: authors[o.id], text: o.text, context }));
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return bluff.start(api);
    if (st.phase === 'write' && !fresh(api, st)) return ask(api, st.deck, st.i, 'host');
    if (st.phase === 'pick' && !fresh(api, st)) return reveal(api);
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'write' && st.phase !== 'pick')) return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (st.phase === 'write' && allWritten(api, st)) toPick(api);
    else if (st.phase === 'pick' && allPicked(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : null;
    };
    const playing = Array.isArray(st.in) ? st.in : [];
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const inRound = mine !== null && playing.includes(mine);
    const watching = mine === null || (st.phase === 'write' && !waiting && !inRound);
    const sameRound = local.n === st.n;
    const wrote = mine !== null && st.done.includes(mine);
    const sent = sameRound && local.sent ? cleanShared(local.sent, FAKE_MAX) : null;
    const options = st.phase === 'write' ? [] : optionsFrom((k) => snap.state[k], st);
    const live = playing.filter((s) => bySlot.has(s) && bySlot.get(s).present);
    const base = {
      phase: st.phase,
      n: st.n,
      nonce: st.nonce,
      number: st.i + 1,
      total: st.total,
      fact: st.f.t,
      fid: st.f.id,
      starts: st.starts,
      ends: st.ends,
      note: st.note,
      waiting,
      watching,
      players: live.length,
    };
    if (st.phase === 'write') {
      return {
        ...base,
        canWrite: inRound && !wrote,
        wrote,
        mySent: wrote ? sent : null,
        done: st.done.filter((s) => live.includes(s)).length,
        doneBy: st.done.map(faceOf).filter(Boolean),
      };
    }
    if (st.phase === 'pick') {
      const mineKey = sent ? plainKey(sent) : null;
      const cards = options.map((o) => ({ ...o, isMine: Boolean(mineKey) && plainKey(o.text) === mineKey }));
      const choosable = cards.some((c) => !c.isMine);
      const picked = mine !== null && st.picked.includes(mine);
      const myPick = sameRound && Number.isInteger(local.pick) ? local.pick : null;
      return {
        ...base,
        cards,
        canPick: mine !== null && !watching && !picked && myPick === null && choosable,
        hasPicked: picked || myPick !== null,
        myPick,
        picked: st.picked.length,
        pickedBy: st.picked.map(faceOf).filter(Boolean),
      };
    }
    const textOf = new Map(options.map((o) => [o.id, o.text]));
    const myPick = sameRound && Number.isInteger(local.pick) ? local.pick : null;
    const rows = Array.isArray(st.res)
      ? st.res.map(([id, owners, by, truth]) => ({
          id,
          text: textOf.get(id) ?? '',
          truth: Boolean(truth),
          owners: owners.map(faceOf).filter(Boolean),
          isMine: mine !== null && owners.includes(mine),
          pickers: by.map(faceOf).filter(Boolean),
          fooled: truth ? 0 : by.length,
          iPicked: mine !== null && by.includes(mine),
        }))
      : options.map((o) => ({ id: o.id, text: o.text, truth: o.id === st.truth, owners: [], isMine: false, pickers: [], fooled: 0, iPicked: o.id === myPick }));
    const myRow = rows.find((r) => r.iPicked) || null;
    const fooledByMe = rows.filter((r) => r.isMine).reduce((n, r) => n + r.fooled, 0);
    return {
      ...base,
      lost: Boolean(st.lost),
      answer: st.answer,
      cards: rows,
      count: st.count,
      foundTruth: Boolean(myRow && myRow.truth),
      fooledBy: myRow && !myRow.truth ? myRow.owners : [],
      fooledCount: fooledByMe,
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
    };
  },
};

export default bluff;
