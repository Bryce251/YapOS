import { cleanShared } from './text.js';

export const FUN = 'fun';
export const REACTIONS = Object.freeze(['😂', '🔥', '💀', '👏', '😮', '❤️']);
export const REACT_GAP_MS = 400;
export const REACT_WINDOW_MS = 10000;
export const REACT_MAX = 12;
export const LINE_GAP_MS = 3500;
export const LINE_STALE_MS = 6000;
export const LINE_SHOW_MS = 3800;
export const LINE_MAX = 120;
export const DRAMA_MS = 600;
export const AWARDS_MAX = 6;
export const AWARD_TITLE_MAX = 32;
export const AWARD_WHY_MAX = 80;
export const HIGHLIGHTS_MAX = 5;
export const HIGHLIGHT_MAX = 120;
export const HINT_MAX = 120;
export const UPSET_MAX = 140;
export const STREAK_MIN = 3;
export const QUIET_ROUND = 3;
export const ROAST_ROUND = 3;
export const ROAST_MAX = 2;
export const HL_RE = /^hl\.\d$/;

export const CARDS = Object.freeze([
  Object.freeze({ id: 'swap', code: 's', emoji: '🔄', name: 'Swap', text: 'Swap your score with the player just above you.' }),
  Object.freeze({ id: 'freeze', code: 'f', emoji: '❄️', name: 'Freeze', text: "Freeze someone's next turn.", target: true }),
  Object.freeze({ id: 'double', code: 'd', emoji: '🎯', name: 'Double', text: 'Your next points count double.' }),
  Object.freeze({ id: 'peek', code: 'p', emoji: '👀', name: 'Peek', text: 'Get a secret hint only you can see.' }),
]);
export const CARD_IDS = Object.freeze(CARDS.map((c) => c.id));

export const PARTY_SETTINGS = Object.freeze([
  Object.freeze({ id: 'reactions', key: 're', label: '😂 Reactions', title: 'Everyone, watchers too, can send emoji reactions.' }),
  Object.freeze({ id: 'cards', key: 'cc', label: '🃏 Chaos cards', title: 'Each player gets one surprise card per game.' }),
  Object.freeze({ id: 'final', key: 'fr', label: '🎯 Final round ×2', title: 'The last round is worth double points.' }),
  Object.freeze({ id: 'drama', key: 'dr', label: '🎙️ Host commentary', title: 'Lead changes, streaks and friendly callouts.' }),
]);
export const PARTY_IDS = Object.freeze(PARTY_SETTINGS.map((s) => s.id));

export const LINES = Object.freeze({
  lead: ['👑 {a} takes the lead from {b}!', '👑 New leader: {a}!', '👑 {a} just snatched first place from {b}!', "👑 {a} is in front now. {b}, it's your move!", '👑 Plot twist! {a} leads the pack.'],
  tie: ["🤝 It's all tied up at the top!", '🤝 Dead heat at the top. Anyone can take this!'],
  streak: ['🔥 {a} is on FIRE, {n} in a row!', "🔥 {a} can't miss right now. {n} straight!", "🔥 Someone stop {a}! That's {n} in a row.", '🔥 {a} is heating up, {n} in a row!', '🔥 {n} in a row for {a}. Unreal.'],
  quiet: ['🤫 {a} has been very quiet...', '🤫 {a} is saving their energy for later, surely.', "👀 We haven't heard much from {a} yet.", '🤫 {a} is playing the long game. Very long.', '👀 {a} is lurking. Watch out.'],
  roast: ['✨ {a} is in last, but the vibes are immaculate.', '🐢 {a} is just warming up. Probably.', '💛 {a} is saving the best for last. Hopefully.', '💛 Bottom of the board, top of our hearts, {a}.', '🐢 Slow and steady, {a}. Mostly steady.', '🌱 {a} is a late bloomer. Any minute now.'],
  final: ['🎯 FINAL ROUND! Every point counts double.', '🎯 Last round, double points. Anything can happen!', '🎯 This is it! Double points on the line.'],
  swap: ['🔄 {a} swapped scores with {b}! Chaos!', '🔄 {a} just traded places with {b}. Rude. Brilliant.', '🔄 {b} has been swapped by {a}!'],
  double: ['🎯 {a} is going for double points!', '🎯 {a} played Double. Next points count twice!', "🎯 Double trouble: {a}'s next points are worth twice as much."],
  freeze: ['❄️ {a} froze {b}! Brrr.', '❄️ {b} is on ice, thanks to {a}.', '❄️ {a} put {b} in the freezer!'],
  peek: ['👀 {a} took a sneaky peek...', '👀 {a} knows something we don\'t.', '👀 {a} peeked at a secret hint.'],
  close: ['😬 So close, {a}!', '😬 {a} was SO close!', '😬 Almost, {a}! Almost.'],
  steal: ['😈 {a} steals it!', '😈 Stolen! Nice one, {a}.', '😈 {a} swooped in for the steal!'],
  fast: ['⚡ {a} answered in a flash!', '⚡ {a} is a speed demon!', '⚡ Blink and you missed {a}.'],
  out: ['👋 {a} is out!', '👋 That is the end of the road for {a}.', '👋 {a} has been knocked out!'],
  hot: ['🔥 {a} is getting warm!', '🔥 Ooh, {a} is close!', '🔥 {a} is on the right track!'],
  cold: ['🥶 {a} is ice cold.', '🥶 Brrr, not even close, {a}.', "🥶 {a}, that's a bold guess."],
  wrong: ['🙈 Oof, {a}.', '🙈 Nice try, {a}!', '🙈 {a} swung and missed.'],
  comeback: ['📈 {a} is climbing back up!', '📈 Never count out {a}!', '📈 {a} is making a comeback!'],
  win: ['🏆 {a} wins the round!', '🏆 Round to {a}!', '🏆 {a} takes it!'],
  wager: ['💰 {a} bet big!', '💰 {a} is all in!', '💰 Bold wager from {a}!'],
});

export const SAY_KINDS = Object.freeze(['streak', 'close', 'steal', 'fast', 'out', 'hot', 'cold', 'wrong', 'comeback', 'win', 'wager', 'custom']);

export const PRIORITY = Object.freeze({ final: 9, swap: 8, freeze: 8, double: 7, peek: 7, lead: 6, tie: 4, out: 5, steal: 5, streak: 4, win: 3, wager: 3, comeback: 3, custom: 3, close: 2, hot: 2, cold: 2, wrong: 1, fast: 1, roast: 1, quiet: 1 });

export const BANNER_KINDS = Object.freeze(['lead', 'final']);

export function cardById(id) {
  return CARDS.find((c) => c.id === id) || null;
}

export function cardByCode(code) {
  return CARDS.find((c) => c.code === code) || null;
}

export function cardsFor(game) {
  const list = game && Array.isArray(game.cards) ? game.cards : [];
  return CARD_IDS.filter((id) => list.includes(id) && (id !== 'peek' || typeof game.hint === 'function'));
}

export function dealOne(allowed, random = Math.random) {
  const list = Array.isArray(allowed) ? allowed.filter((id) => CARD_IDS.includes(id)) : [];
  if (!list.length) return null;
  const card = cardById(list[Math.floor(random() * list.length) % list.length]);
  return card ? card.code : null;
}

export function dealCards(slots, allowed, random = Math.random) {
  const out = {};
  for (const slot of slots || []) {
    if (!Number.isInteger(slot)) continue;
    const code = dealOne(allowed, random);
    if (code) out[slot] = code;
  }
  return out;
}

export function partyOf(room) {
  const px = room && room.px && typeof room.px === 'object' ? room.px : {};
  const out = {};
  for (const s of PARTY_SETTINGS) out[s.id] = px[s.key] !== 0;
  return out;
}

export function partyPatch(room, id, on) {
  const spec = PARTY_SETTINGS.find((s) => s.id === id);
  if (!spec) return null;
  const px = { ...(room && room.px && typeof room.px === 'object' ? room.px : {}) };
  if (on) delete px[spec.key];
  else px[spec.key] = 0;
  return Object.keys(px).length ? px : null;
}

export function ranked(points, slots) {
  const pts = points || {};
  const list = [...new Set((slots || []).filter(Number.isInteger))];
  return list.map((slot) => ({ slot, pts: Number(pts[slot]) || 0 })).sort((a, b) => b.pts - a.pts || a.slot - b.slot);
}

export function slotAbove(points, slots, slot) {
  const list = ranked(points, slots);
  const mine = list.find((x) => x.slot === slot);
  if (!mine) return null;
  const above = list.filter((x) => x.pts > mine.pts);
  if (!above.length) return null;
  return above[above.length - 1].slot;
}

export function leaderOf(points, slots) {
  const list = ranked(points, slots);
  if (!list.length || list[0].pts <= 0) return null;
  if (list.length > 1 && list[1].pts === list[0].pts) return -1;
  return list[0].slot;
}

export function placeOf(points, slots, slot) {
  const list = ranked(points, slots);
  const mine = list.find((x) => x.slot === slot);
  if (!mine) return -1;
  return list.filter((x) => x.pts > mine.pts).length;
}

export function fillLine(tpl, vars = {}) {
  return String(tpl).replace(/\{([abn])\}/g, (_, k) => {
    const v = vars[k];
    if (k === 'n') return Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '';
    return typeof v === 'string' && v ? v : 'Someone';
  });
}

export function pickLine(kind, vars = {}, memo = null, random = Math.random) {
  const bank = LINES[kind];
  if (!bank || !bank.length) return null;
  const last = memo && memo.last ? memo.last[kind] : undefined;
  const lastText = memo ? memo.text : null;
  const order = bank.map((_, i) => i);
  const start = Math.floor(random() * order.length) % order.length;
  for (let k = 0; k < order.length; k += 1) {
    const i = (start + k) % order.length;
    if (order.length > 1 && i === last) continue;
    const text = fillLine(bank[i], vars);
    if (order.length > 1 && text === lastText) continue;
    if (memo) {
      memo.last = memo.last || {};
      memo.last[kind] = i;
      memo.text = text;
    }
    return text;
  }
  const text = fillLine(bank[0], vars);
  if (memo) memo.text = text;
  return text;
}

export function ordinal(n) {
  const v = Math.round(Number(n) || 0);
  const s = v % 100;
  if (s >= 11 && s <= 13) return `${v}th`;
  if (v % 10 === 1) return `${v}st`;
  if (v % 10 === 2) return `${v}nd`;
  if (v % 10 === 3) return `${v}rd`;
  return `${v}th`;
}

export function num(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function maxOf(map, min = 1) {
  let best = null;
  let val = -Infinity;
  for (const [k, v] of Object.entries(map || {})) {
    const n = Number(v) || 0;
    const slot = Number(k);
    if (!Number.isInteger(slot) || n < min) continue;
    if (n > val || (n === val && slot < best)) {
      best = slot;
      val = n;
    }
  }
  return best === null ? null : { slot: best, n: val };
}

export function cleanEmojiLoose(raw, fallback = '🏅') {
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim();
  if (!text || Array.from(text).length > 4 || /[A-Za-z0-9<>]/.test(text)) return fallback;
  return text;
}

export function cleanAward(raw, live) {
  if (!raw || typeof raw !== 'object') return null;
  const ok = (s) => Number.isInteger(s) && (!live || live.has(s));
  const who = (Array.isArray(raw.who) ? raw.who : [raw.who]).filter(ok).slice(0, 4);
  if (!who.length) return null;
  const t = cleanShared(raw.title, AWARD_TITLE_MAX);
  if (!t) return null;
  const y = cleanShared(raw.why, AWARD_WHY_MAX);
  const out = { e: cleanEmojiLoose(raw.emoji), t, s: [...new Set(who)] };
  if (y) out.y = y;
  return out;
}

export function cleanHighlight(raw, live) {
  if (!raw || typeof raw !== 'object') return null;
  const x = cleanShared(raw.text, HIGHLIGHT_MAX);
  if (!x) return null;
  const s = Number.isInteger(raw.who) && (!live || live.has(raw.who)) ? raw.who : null;
  return s === null ? { x } : { x, s };
}

export function genericAwards(stats, ctx = {}) {
  const st = stats || {};
  const out = [];
  const fast = maxOf(st.fast, 1);
  if (fast) out.push({ e: '⚡', t: 'Speed demon', s: [fast.slot], y: fast.n === 1 ? 'Fastest answer of the game' : `${fast.n} lightning-fast answers` });
  else {
    const hit = maxOf(st.hits, 1);
    if (hit && (st.events || 0) >= 2 && Object.keys(st.hits || {}).length >= 2) out.push({ e: '⚡', t: 'Speed demon', s: [hit.slot], y: `Biggest single score: +${num(hit.n)}` });
  }
  const played = Array.isArray(st.played) ? st.played.filter((x) => x && Number.isInteger(x.slot)) : [];
  if (played.length) {
    const first = played[0];
    const card = cardByCode(first.code);
    out.push({ e: '🃏', t: 'Chaos agent', s: [first.slot], y: card ? `Played ${card.emoji} ${card.name} first` : 'Played the first chaos card' });
  }
  const finals = ctx.finalPlace || {};
  let climb = null;
  for (const [k, worst] of Object.entries(st.worst || {})) {
    const slot = Number(k);
    const end = finals[slot];
    if (!Number.isInteger(slot) || !Number.isInteger(end) || !Number.isInteger(worst)) continue;
    const up = worst - end;
    if (up >= 2 && (!climb || up > climb.up || (up === climb.up && slot < climb.slot))) climb = { slot, up, from: worst, to: end };
  }
  if (climb) out.push({ e: '📈', t: 'Comeback kid', s: [climb.slot], y: `Climbed from ${ordinal(climb.from + 1)} to ${ordinal(climb.to + 1)}` });
  const fire = maxOf(st.bestStreak, STREAK_MIN);
  if (fire) out.push({ e: '🔥', t: 'On fire', s: [fire.slot], y: `${fire.n} in a row` });
  const hype = maxOf(st.re, 5);
  if (hype) out.push({ e: '📣', t: 'Hype machine', s: [hype.slot], y: `Sent ${hype.n} reactions` });
  const frozen = maxOf(st.frozen, 1);
  if (frozen && played.some((x) => x.code === 'f')) out.push({ e: '🧊', t: 'Ice cold', s: [frozen.slot], y: 'Got frozen and kept going' });
  return out;
}

export function upsetLine(stats, ctx = {}) {
  const st = stats || {};
  const win = Array.isArray(ctx.winners) ? ctx.winners.filter(Number.isInteger) : [];
  const name = typeof ctx.nameOf === 'function' ? ctx.nameOf : () => 'Someone';
  if (win.length === 1) {
    const w = win[0];
    const behind = Number((st.behind || {})[w]) || 0;
    const final = Number((ctx.points || {})[w]) || 0;
    if (behind > 0 && behind * 5 >= final && (ctx.players || 0) >= 2) return `😱 Biggest upset: ${name(w)} came back from ${num(behind)} points behind to win!`;
  }
  if ((st.changes || 0) >= 3) return `🎢 The lead changed ${st.changes} times this game!`;
  if (win.length === 1 && (st.changes || 0) === 0 && (ctx.players || 0) >= 2 && (st.events || 0) >= 3) return `👑 ${name(win[0])} led from start to finish.`;
  return null;
}

export function fitAwards(list, max = AWARDS_MAX) {
  const out = [];
  const seen = new Set();
  for (const a of list || []) {
    if (!a || out.length >= max) continue;
    const sig = `${a.t}|${a.s.join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(a);
  }
  return out;
}

export function teamCodes(info) {
  const raw = info && info.tm && typeof info.tm === 'object' ? info.tm : null;
  const out = {};
  if (raw) {
    for (const [slot, t] of Object.entries(raw)) if (/^\d+$/.test(slot) && typeof t === 'string' && /^[a-z]{1,4}$/.test(t)) out[slot] = t;
  } else if (info && info.teams && typeof info.teams === 'object') {
    for (const [slot, t] of Object.entries(info.teams)) {
      if (!/^\d+$/.test(slot) || typeof t !== 'string') continue;
      const code = t.trim().slice(0, 1).toLowerCase();
      if (/^[a-z]$/.test(code)) out[slot] = code;
    }
  }
  const teams = new Set(Object.values(out));
  return teams.size >= 2 ? out : null;
}
