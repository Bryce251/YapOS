import { PROMPTS, promptById } from '../../data/hottakes.js';
import { shuffle } from '../engine.js';
import { cleanShared } from '../text.js';
import { jsonBytes } from '../limits.js';
import { face } from './trivia.js';

export const KEY = 'hottakes';
export const ANSWER_PREFIX = 'hottakes.';
export const RECAP_KEY = 'hotrecap';
export const ANSWER_MAX = 80;
export const VOTE_MS = 20000;
export const RECAP_MS = 15000;
export const RECAP_BYTES = 3600;
export const REVEAL_BASE_MS = 7000;
export const REVEAL_STEP_MS = 600;
export const REVEAL_MAX_MS = 16000;
export const VOTE_POINTS = 100;
export const TOP_BONUS = 200;
export const LATE_MIN_MS = 10000;
export const CHUNK_BYTES = 3400;
export const CODE_MAX = 2000;

export function answerKey(i) {
  return `${ANSWER_PREFIX}${i}`;
}

function stream(nonce, i) {
  let s = ((nonce >>> 0) ^ Math.imul(i + 1, 2654435761)) >>> 0;
  s = Math.imul(s ^ (s >>> 15), 2246822519) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
  return (s ^ (s >>> 16)) & 0xffff;
}

export function seal(text, nonce) {
  return Array.from(String(text ?? ''))
    .map((ch, i) => (ch.codePointAt(0) ^ stream(nonce, i)).toString(36))
    .join('.');
}

export function unseal(code, nonce) {
  if (typeof code !== 'string' || !code || code.length > CODE_MAX) return '';
  let out = '';
  const parts = code.split('.');
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^[0-9a-z]{1,4}$/.test(parts[i])) return '';
    const cp = parseInt(parts[i], 36) ^ stream(nonce, i);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function buildDeck(count, random = Math.random) {
  return shuffle(PROMPTS, random)
    .slice(0, Math.max(1, count))
    .map((p) => p.id);
}

export function revealMs(count) {
  return Math.min(REVEAL_MAX_MS, REVEAL_BASE_MS + REVEAL_STEP_MS * Math.max(0, count));
}

export function chunk(list, max = CHUNK_BYTES) {
  const out = [];
  let cur = [];
  for (const item of list) {
    if (cur.length && jsonBytes(cur.concat([item])) > max) {
      out.push(cur);
      cur = [];
    }
    cur.push(item);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function tally(authors, votes) {
  const count = {};
  const by = {};
  for (const id of Object.keys(authors)) {
    count[id] = 0;
    by[id] = [];
  }
  for (const [slot, id] of Object.entries(votes || {})) {
    if (count[id] === undefined) continue;
    count[id] += 1;
    by[id].push(Number(slot));
  }
  const best = Math.max(0, ...Object.values(count));
  const top = best > 0 ? Object.keys(count).filter((id) => count[id] === best).map(Number) : [];
  const gained = {};
  const res = Object.keys(authors)
    .map(Number)
    .map((id) => {
      const author = authors[id];
      const pts = count[id] * VOTE_POINTS + (top.includes(id) ? TOP_BONUS : 0);
      if (pts) gained[author] = (gained[author] || 0) + pts;
      return [id, author, count[id], by[id].sort((a, b) => a - b)];
    })
    .sort((a, b) => b[2] - a[2] || a[0] - b[0]);
  return { res, top, gained };
}

function give(api, slot, n) {
  const got = api.addPoints(slot, n);
  return Number.isFinite(got) ? got : n;
}

function say(api, kind, data) {
  if (typeof api.say === 'function') api.say(kind, data);
}

function nameAt(api, slot) {
  return typeof api.nameOf === 'function' ? api.nameOf(slot) : 'Someone';
}

export function fitRecap(list, max = RECAP_BYTES) {
  let out = list.slice();
  while (out.length > 1 && jsonBytes(out) > max) out = out.slice(1);
  if (jsonBytes(out) > max) out = [];
  return out;
}

export function biggestFan(fans) {
  let best = null;
  for (const [voter, row] of Object.entries(fans || {})) {
    for (const [author, n] of Object.entries(row || {})) {
      if (n < 2) continue;
      if (!best || n > best.n) best = { fan: Number(voter), of: Number(author), n };
    }
  }
  return best;
}

function remember(api, st, cur, res, top, answers) {
  const fans = api.memory.fans && typeof api.memory.fans === 'object' ? api.memory.fans : {};
  api.memory.fans = fans;
  for (const [voter, id] of Object.entries(cur.votes || {})) {
    const author = cur.authors[id];
    if (!Number.isInteger(author)) continue;
    fans[voter] = fans[voter] || {};
    fans[voter][author] = (fans[voter][author] || 0) + 1;
  }
  const votes = api.memory.votes && typeof api.memory.votes === 'object' ? api.memory.votes : {};
  api.memory.votes = votes;
  for (const row of res) votes[row[1]] = (votes[row[1]] || 0) + row[2];
  const best = res.find((row) => top.includes(row[0]));
  if (!best) return;
  const text = answers.get(best[0]);
  if (!text) return;
  const prev = api.get(RECAP_KEY);
  const list = Array.isArray(prev) ? prev.filter((x) => x && x.n !== st.n) : [];
  list.push({ n: st.n, no: st.nonce, id: best[0], p: st.p.id, t: text, a: best[1], v: best[3], k: best[2], all: res.reduce((sum, row) => sum + row[2], 0) });
  api.put(RECAP_KEY, fitRecap(list));
}

function cheer(api, res, top) {
  const sk = api.memory.sk && typeof api.memory.sk === 'object' ? api.memory.sk : {};
  api.memory.sk = sk;
  const winners = res.filter((row) => top.includes(row[0])).map((row) => row[1]);
  for (const s of Object.keys(sk).map(Number)) if (!winners.includes(s)) sk[s] = 0;
  for (const s of new Set(winners)) {
    sk[s] = (sk[s] || 0) + 1;
    if (sk[s] >= 2) say(api, 'streak', { slot: s, n: sk[s] });
  }
  const total = res.reduce((sum, row) => sum + row[2], 0);
  const lead = res[0];
  if (lead && top.length === 1 && total >= 3 && lead[2] === total) {
    say(api, 'custom', { text: `🌶️ Every single vote went to ${nameAt(api, lead[1])}!` });
    return;
  }
  if (lead && top.length === 1) say(api, 'win', { slot: lead[1] });
  const second = res[1];
  if (lead && second && top.length === 1 && lead[2] >= 2 && lead[2] - second[2] === 1) say(api, 'close', { slot: second[1] });
}

function clearAnswers(api) {
  for (const k of api.keys()) if (k.startsWith(ANSWER_PREFIX)) api.put(k, null);
}

function liveSlots(api) {
  return api.players().map((p) => p.slot);
}

function inPlay(api, st) {
  const live = liveSlots(api);
  return Array.isArray(st.in) ? live.filter((s) => st.in.includes(s)) : live;
}

function ask(api, deck, i, note) {
  const p = promptById(deck[i]);
  if (!p) return next(api, deck, i);
  clearAnswers(api);
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const nonce = 1 + Math.floor(api.random() * 65535);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { n, answers: {}, authors: null, votes: {} };
  if (typeof api.round === 'function') api.round(i + 1, deck.length);
  api.put(KEY, {
    v: 1,
    deck,
    i,
    total: deck.length,
    n,
    nonce,
    phase: 'write',
    p: { id: p.id, t: p.t },
    in: liveSlots(api),
    wait: [],
    done: [],
    voted: [],
    count: 0,
    chunks: 0,
    res: null,
    top: [],
    gained: {},
    lost: false,
    note: note || null,
    starts,
    ends,
    rc: api.settings.recap === false ? 0 : 1,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, deck, i) {
  if (i + 1 < deck.length && api.players().length) return ask(api, deck, i + 1);
  clearAnswers(api);
  const st = api.get(KEY);
  const recap = api.get(RECAP_KEY);
  if (st && st.phase === 'reveal' && st.rc !== 0 && Array.isArray(recap) && recap.length && api.players().length) {
    const starts = api.now();
    const ends = starts + RECAP_MS;
    api.put(KEY, { ...st, phase: 'recap', chunks: 0, count: 0, res: null, top: [], gained: {}, note: null, starts, ends });
    api.setDeadline(ends);
    return undefined;
  }
  return api.finish();
}

function fresh(api, st) {
  const cur = api.memory.cur;
  return cur && cur.n === st.n ? cur : null;
}

function toReveal(api, st, extra) {
  const ends = api.now() + revealMs(st.count);
  api.put(KEY, { ...st, phase: 'reveal', starts: api.now(), ends, ...extra });
  api.setDeadline(ends);
}

function toVote(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write') return;
  const cur = fresh(api, st);
  const entries = cur ? Object.entries(cur.answers) : [];
  if (!entries.length) {
    api.memory.cur = null;
    return toReveal(api, { ...st, wait: [], count: 0, chunks: 0 }, { res: [], top: [], gained: {}, note: st.note === 'host' ? null : st.note });
  }
  const order = shuffle(entries, api.random);
  const authors = {};
  const list = order.map(([slot, text], id) => {
    authors[id] = Number(slot);
    return [id, text];
  });
  cur.authors = authors;
  cur.votes = {};
  cur.answers = {};
  const parts = chunk(list);
  parts.forEach((part, i) => api.put(answerKey(i), part));
  const starts = api.now();
  const ends = starts + VOTE_MS;
  const wait = Array.isArray(st.wait) ? st.wait : [];
  const joined = (Array.isArray(st.in) ? st.in : []).concat(wait.filter((s) => !(st.in || []).includes(s)));
  const after = { ...st, phase: 'vote', in: joined, wait: [], count: list.length, chunks: parts.length, voted: [], note: null, starts, ends };
  api.put(KEY, after);
  api.setDeadline(ends);
  if (allVoted(api, after)) reveal(api);
}

function voters(api, st, cur) {
  const live = inPlay(api, st);
  if (!cur || !cur.authors) return live;
  const ids = Object.keys(cur.authors);
  return live.filter((s) => ids.some((id) => cur.authors[id] !== s));
}

function allWritten(api, st) {
  const live = inPlay(api, st);
  return live.length > 0 && live.every((s) => st.done.includes(s));
}

function allVoted(api, st) {
  const need = voters(api, st, fresh(api, st));
  return need.every((s) => st.voted.includes(s));
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = fresh(api, st);
  if (!cur || !cur.authors) {
    api.memory.cur = null;
    return toReveal(api, st, { res: null, top: [], gained: {}, lost: true, note: 'host' });
  }
  const { res, top, gained: base } = tally(cur.authors, cur.votes);
  const gained = {};
  for (const [slot, pts] of Object.entries(base)) gained[slot] = give(api, Number(slot), pts);
  const authorsTop = res.filter((row) => top.includes(row[0])).map((row) => row[1]);
  api.memory.tops = [...new Set((Array.isArray(api.memory.tops) ? api.memory.tops : []).concat(authorsTop.filter(Number.isInteger)))];
  const texts = new Map(answersFrom(Object.fromEntries(api.keys().filter((k) => k.startsWith(ANSWER_PREFIX)).map((k) => [k, api.get(k)])), st).map((a) => [a.id, a.text]));
  remember(api, st, cur, res, top, texts);
  cheer(api, res, top);
  api.memory.cur = null;
  return toReveal(api, st, { res, top, gained, note: null });
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || (st.phase !== 'write' && st.phase !== 'vote')) return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot)) return false;
  if (st.phase === 'vote') {
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

function onAnswer(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write' || action.n !== st.n) return;
  const cur = fresh(api, st);
  if (!cur || cur.answers[slot] !== undefined) return;
  if (!ensureIn(api, st, slot)) return;
  const text = cleanShared(unseal(action.code, st.nonce), ANSWER_MAX);
  if (!text) return;
  cur.answers[slot] = text;
  if (!st.done.includes(slot)) st.done.push(slot);
  api.put(KEY, st);
  if (allWritten(api, st)) toVote(api);
}

function onVote(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote' || action.n !== st.n || !Number.isInteger(action.id)) return;
  const cur = fresh(api, st);
  if (!cur || !cur.authors || cur.votes[slot] !== undefined) return;
  if (cur.authors[action.id] === undefined || cur.authors[action.id] === slot) return;
  if (!ensureIn(api, st, slot)) return;
  cur.votes[slot] = action.id;
  if (!st.voted.includes(slot)) st.voted.push(slot);
  api.put(KEY, st);
  if (allVoted(api, st)) reveal(api);
}

function answersFrom(state, st) {
  const out = [];
  for (let i = 0; i < (st.chunks || 0); i += 1) {
    const part = state[answerKey(i)];
    if (Array.isArray(part)) for (const row of part) if (Array.isArray(row) && Number.isInteger(row[0]) && typeof row[1] === 'string') out.push({ id: row[0], text: row[1] });
  }
  return out;
}

export function answerRef(n, nonce, id) {
  return `hot.${n}.${nonce}.${id}`;
}

export function promptParts(text) {
  const at = String(text || '').indexOf('____');
  if (at < 0) return { before: String(text || ''), after: '' };
  return { before: text.slice(0, at), after: text.slice(at + 4) };
}

const hottakes = {
  id: 'hottakes',
  name: 'Hot Takes',
  emoji: '🌶️',
  category: 'party',
  blurb: 'Fill in the blank with your funniest answer, then vote for the best one. Votes are points.',
  minPlayers: 3,
  keys: [KEY, RECAP_KEY],
  prefixes: [ANSWER_PREFIX],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [3, 4, 5, 7].map((v) => ({ value: v, label: String(v) })), default: 4 },
    { id: 'timer', label: 'Time to write', type: 'choice', options: [30, 45, 60, 90].map((v) => ({ value: v, label: `${v} s` })), default: 45 },
    { id: 'recap', label: '👀 Who voted for what', type: 'toggle', default: true, fun: true },
  ],

  start(api) {
    api.memory.fans = {};
    api.memory.votes = {};
    api.memory.sk = {};
    api.memory.tops = [];
    if (api.get(RECAP_KEY) !== null) api.put(RECAP_KEY, null);
    ask(api, buildDeck(api.settings.rounds, api.random), 0);
  },

  hint(api) {
    const st = api.get(KEY);
    const cur = st ? fresh(api, st) : null;
    if (!st || st.phase !== 'vote' || !cur || !cur.authors) return null;
    const count = {};
    for (const id of Object.values(cur.votes || {})) count[id] = (count[id] || 0) + 1;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const text = answersFrom(Object.fromEntries(api.keys().filter((k) => k.startsWith(ANSWER_PREFIX)).map((k) => [k, api.get(k)])), st).find((a) => String(a.id) === best[0]);
    if (!text) return null;
    return `👀 Leading so far with ${best[1] === 1 ? '1 vote' : `${best[1]} votes`}: “${text.text}”`;
  },

  awards(api) {
    const out = [];
    const votes = api.memory.votes || {};
    const list = Object.entries(votes).map(([s, n]) => [Number(s), n]).filter(([s, n]) => Number.isInteger(s) && n > 0);
    if (list.length) {
      const best = Math.max(...list.map((x) => x[1]));
      if (best >= 2) out.push({ emoji: '🌶️', title: 'Hottest takes', who: list.filter((x) => x[1] === best).map((x) => x[0]), why: `${best} votes in total` });
    }
    const fan = biggestFan(api.memory.fans);
    if (fan) out.push({ emoji: '🥰', title: 'Biggest fan', who: fan.fan, why: `Voted for ${nameAt(api, fan.of)} ${fan.n} times` });
    const recap = api.get(RECAP_KEY);
    const sweep = (Array.isArray(recap) ? recap : []).find((x) => x && x.k >= 3 && x.k === x.all);
    if (sweep && Number.isInteger(sweep.a)) out.push({ emoji: '💯', title: 'Clean sweep', who: sweep.a, why: 'Got every single vote in a round' });
    return out;
  },

  highlights(api) {
    const recap = api.get(RECAP_KEY);
    return (Array.isArray(recap) ? recap : [])
      .filter((x) => x && typeof x.t === 'string' && Number.isInteger(x.a))
      .sort((a, b) => (b.k || 0) - (a.k || 0))
      .slice(0, 5)
      .map((x) => {
        const p = promptById(x.p);
        const { before, after } = promptParts(p ? p.t : '');
        const full = p && p.t.includes('____') ? `${before}${x.t}${after}` : `“${x.t}”`;
        return { text: full.length <= 120 ? full : `“${x.t}”`, who: x.a };
      });
  },

  results(api) {
    const tops = Array.isArray(api.memory.tops) ? api.memory.tops.filter(Number.isInteger) : [];
    return { extra: tops.length ? { topTake: tops } : {} };
  },

  intent(api, slot, action) {
    if (action.type === 'answer') onAnswer(api, slot, action);
    else if (action.type === 'vote') onVote(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'write') return toVote(api);
    if (st.phase === 'vote') return reveal(api);
    if (st.phase === 'recap') return api.finish();
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['write', 'vote', 'reveal', 'recap'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      hottakes.deadline(api);
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
    if (st && st.phase === 'recap') {
      const recap = api.get(RECAP_KEY);
      return (Array.isArray(recap) ? recap : [])
        .filter((x) => x && typeof x.t === 'string' && Number.isInteger(x.a) && Number.isInteger(x.id))
        .map((x) => {
          const p = promptById(x.p);
          return { r: answerRef(x.n, x.no, x.id), author: x.a, text: x.t, context: p ? `Prompt: ${p.t}` : null };
        });
    }
    if (!st || (st.phase !== 'vote' && st.phase !== 'reveal')) return [];
    const authors = {};
    if (st.phase === 'vote') {
      const cur = fresh(api, st);
      if (cur && cur.authors) Object.assign(authors, cur.authors);
    } else if (Array.isArray(st.res)) {
      for (const row of st.res) if (Array.isArray(row)) authors[row[0]] = row[1];
    }
    const out = [];
    for (let i = 0; i < (st.chunks || 0); i += 1) {
      const part = api.get(answerKey(i));
      if (!Array.isArray(part)) continue;
      for (const row of part) {
        if (!Array.isArray(row) || !Number.isInteger(row[0]) || typeof row[1] !== 'string') continue;
        const author = authors[row[0]];
        if (!Number.isInteger(author)) continue;
        out.push({ r: answerRef(st.n, st.nonce, row[0]), author, text: row[1], context: st.p && st.p.t ? `Prompt: ${st.p.t}` : null });
      }
    }
    return out;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return hottakes.start(api);
    if (st.phase === 'write' && !fresh(api, st)) return ask(api, st.deck, st.i, 'host');
    if (st.phase === 'vote' && !fresh(api, st)) return reveal(api);
    if (api.deadline === null) api.setDeadline(st.phase === 'recap' ? Math.max(api.now(), st.ends || 0) : api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'write' && st.phase !== 'vote')) return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (st.phase === 'write' && allWritten(api, st)) toVote(api);
    else if (st.phase === 'vote' && allVoted(api, st)) reveal(api);
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
    if (st.phase === 'recap') {
      const recap = Array.isArray(snap.state[RECAP_KEY]) ? snap.state[RECAP_KEY] : [];
      return {
        phase: 'recap',
        n: st.n,
        number: st.total,
        total: st.total,
        starts: st.starts,
        ends: st.ends,
        note: null,
        rounds: recap
          .filter((x) => x && typeof x.t === 'string' && Number.isInteger(x.a))
          .map((x) => {
            const p = promptById(x.p);
            return {
              n: x.n,
              ref: answerRef(x.n, x.no, x.id),
              prompt: p ? p.t : '',
              text: cleanShared(x.t, ANSWER_MAX),
              author: faceOf(x.a) || { name: 'Someone', initials: '?', hue: 20, isMe: false },
              isMine: x.a === mine,
              votes: Number(x.k) || 0,
              voters: (Array.isArray(x.v) ? x.v : []).map(faceOf).filter(Boolean),
              iVoted: Array.isArray(x.v) && x.v.includes(mine),
            };
          }),
      };
    }
    const playing = Array.isArray(st.in) ? st.in : [];
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const inRound = mine !== null && playing.includes(mine);
    const watching = mine === null || (st.phase === 'write' && !waiting && !inRound);
    const sameRound = local.n === st.n;
    const wrote = mine !== null && st.done.includes(mine);
    const sent = sameRound && local.sent ? cleanShared(local.sent, ANSWER_MAX) : null;
    const answers = st.phase === 'write' ? [] : answersFrom(snap.state, st);
    const textOf = new Map(answers.map((a) => [a.id, a.text]));
    const voted = mine !== null && st.voted.includes(mine);
    const myVote = sameRound && Number.isInteger(local.vote) ? local.vote : null;
    const live = playing.filter((s) => bySlot.has(s) && bySlot.get(s).present);
    const liveDone = st.done.filter((s) => live.includes(s));
    const base = {
      phase: st.phase,
      n: st.n,
      nonce: st.nonce,
      number: st.i + 1,
      total: st.total,
      prompt: st.p.t,
      pid: st.p.id,
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
        done: liveDone.length,
        doneBy: st.done.map(faceOf).filter(Boolean),
      };
    }
    if (st.phase === 'vote') {
      const cards = answers.map((a) => ({ ...a, isMine: Boolean(sent) && a.text === sent }));
      const choosable = cards.some((c) => !c.isMine);
      return {
        ...base,
        cards,
        canVote: mine !== null && !voted && myVote === null && choosable,
        hasVoted: voted || myVote !== null,
        myVote,
        onlyMine: !choosable && cards.length > 0,
        voted: st.voted.length,
        votedBy: st.voted.map(faceOf).filter(Boolean),
      };
    }
    const top = new Set(st.top || []);
    const shown = Array.isArray(st.res)
      ? st.res.map(([id, author, votes, by]) => ({
          id,
          text: textOf.get(id) ?? '',
          author: faceOf(author) || { name: 'Someone', initials: '?', hue: 20, isMe: false },
          isMine: author === mine,
          votes,
          voters: by.map(faceOf).filter(Boolean),
          top: top.has(id),
          gained: (st.gained && st.gained[author]) || 0,
        }))
      : answers.map((a) => ({ id: a.id, text: a.text, author: null, isMine: Boolean(sent) && a.text === sent, votes: 0, voters: [], top: false, gained: 0 }));
    return {
      ...base,
      lost: Boolean(st.lost),
      cards: shown,
      count: st.count,
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      iTopped: shown.some((c) => c.top && c.isMine),
      topIds: [...top],
    };
  },
};

export default hottakes;
