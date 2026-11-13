import { randomBytes, randomInt } from 'node:crypto';
import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip } from '../engine/parse.js';
import { accept as acceptValue, reject as rejectValue, boolField } from '../engine/dashboard.js';
import { HARD_CAP, UNLIMITED, isUnlimited, parseLimit, storeLimit, limitText, limitHelp, atMost, withinLimit } from '../engine/limits.js';

const ID = 'casino';
const cid = (action, ...args) => customId(ID, action, ...args);
const JOB = `${ID}.cleanup`;

const CHECK_MS = 3 * 60_000;
const IDLE_MS = 2 * 60_000;
const MAX_LIVE = 10;
const MAX_CRASH = 3;
const MAX_BET_LIMIT = HARD_CAP;
const CRASH_TICK_MS = 2_000;
const CRASH_DOUBLE_MS = 8_000;
const CRASH_MAX_EDITS = 30;
const FINISHED_KEEP_MS = 10 * 60_000;
const MAX_STAT_USERS = 5000;
const OWED_GIVE_UP_MS = 24 * 3600_000;
const MEDALS = ['🥇', '🥈', '🥉'];
const FUN_NOTE = 'Just for fun with server coins. No real money.';

export const LIMITS = { MAX_LIVE, MAX_CRASH, MAX_BET_LIMIT, CRASH_TICK_MS, CRASH_DOUBLE_MS, CRASH_MAX_EDITS, IDLE_MS, CHECK_MS, MAX_STAT_USERS };

export const GAMES = {
  coinflip: { name: 'Coinflip', icon: '🪙', usage: '/coinflip heads 100', example: 'heads ' },
  dice: { name: 'Dice', icon: '🎲', usage: '/dice over 3 100', example: '6 ' },
  slots: { name: 'Slots', icon: '🎰', usage: '/slots 100', example: '' },
  blackjack: { name: 'Blackjack', icon: '🃏', usage: '/blackjack 100', example: '' },
  roulette: { name: 'Roulette', icon: '🎡', usage: '/roulette red 100', example: 'red ' },
  crash: { name: 'Crash', icon: '🚀', usage: '/crash 100 2x', example: '' },
};
const GAME_KEYS = Object.keys(GAMES);
const LIVE_KINDS = new Set(['blackjack', 'crash']);
const INSTANT_KINDS = { coinflip: true, dice: true, slots: true, roulette: true };

const GAME_ALIASES = {
  coinflip: 'coinflip', flip: 'coinflip', cf: 'coinflip', coin: 'coinflip',
  dice: 'dice', roll: 'dice', die: 'dice',
  slots: 'slots', slot: 'slots', spin: 'slots',
  blackjack: 'blackjack', bj: 'blackjack', 21: 'blackjack',
  roulette: 'roulette', wheel: 'roulette',
  crash: 'crash', rocket: 'crash',
};

const SUBS = ['menu', 'rules', 'odds', 'stats', 'top', 'leaderboard', 'end', 'settings', 'on', 'off', 'minbet', 'maxbet', 'cooldown', 'crashmax'];

const SIDES = { heads: 'heads', head: 'heads', h: 'heads', tails: 'tails', tail: 'tails', t: 'tails' };
const DICE_SIMPLE = { even: 'even', odd: 'odd', high: 'high', hi: 'high', low: 'low', lo: 'low' };
const ROULETTE_WORDS = {
  red: 'red', r: 'red', black: 'black', b: 'black', even: 'even', odd: 'odd', low: 'low', high: 'high', '1-18': 'low', '19-36': 'high',
  '1st': 'd1', first: 'd1', dozen1: 'd1', d1: 'd1', '1-12': 'd1',
  '2nd': 'd2', second: 'd2', dozen2: 'd2', d2: 'd2', '13-24': 'd2',
  '3rd': 'd3', third: 'd3', dozen3: 'd3', d3: 'd3', '25-36': 'd3',
  col1: 'c1', column1: 'c1', c1: 'c1', col2: 'c2', column2: 'c2', c2: 'c2', col3: 'c3', column3: 'c3', c3: 'c3',
  zero: 0, green: 0,
};
const ROULETTE_TOKEN = { red: 'red', black: 'black', even: 'even', odd: 'odd', low: 'low', high: 'high', d1: '1st', d2: '2nd', d3: '3rd', c1: 'col1', c2: 'col2', c3: 'col3' };
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const PICK_WORDS = {
  coinflip: ['heads', 'tails'],
  dice: ['over', 'under', 'even', 'odd', 'high', 'low'],
  slots: ['all', 'half', 'max'],
  blackjack: ['all', 'half', 'max'],
  roulette: Object.keys(ROULETTE_WORDS),
  crash: ['auto', 'all', 'half', 'max'],
};

export const REEL = [
  { key: 'cherry', emoji: '🍒', weight: 7, triple: 10 },
  { key: 'lemon', emoji: '🍋', weight: 6, triple: 12 },
  { key: 'orange', emoji: '🍊', weight: 5, triple: 15 },
  { key: 'grape', emoji: '🍇', weight: 4, triple: 20 },
  { key: 'bell', emoji: '🔔', weight: 3, triple: 40 },
  { key: 'star', emoji: '⭐', weight: 3, triple: 40 },
  { key: 'diamond', emoji: '💎', weight: 2, triple: 100 },
  { key: 'seven', emoji: '7️⃣', weight: 2, triple: 250 },
];
const REEL_BY_KEY = Object.fromEntries(REEL.map((s) => [s.key, s]));

const own = (obj, key) => ((typeof key === 'string' || typeof key === 'number') && Object.hasOwn(obj, key) ? obj[key] : undefined);
const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;
const mention = (uid) => (uid ? `<@${uid}>` : 'someone');
const busyKey = (sid, uid) => `${sid}:${uid}`;
const newId = () => randomBytes(5).toString('hex').slice(0, 8);
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const fmtX = (x100) => `${(x100 / 100).toFixed(2)}x`;

export function reelSymbol(n) {
  let left = n;
  for (const s of REEL) {
    if (left < s.weight) return s.key;
    left -= s.weight;
  }
  return REEL[REEL.length - 1].key;
}

export function slotPayout(keys, bet) {
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  let best = null;
  for (const [k, c] of counts) if (!best || c > best[1]) best = [k, c];
  if (best && best[1] === 3) {
    const num = REEL_BY_KEY[best[0]].triple;
    return { kind: 'triple', symbol: best[0], num, den: 1, payout: Math.floor(bet * num) };
  }
  if (best && best[1] === 2) {
    if (best[0] === 'cherry') return { kind: 'pair', symbol: 'cherry', num: 25, den: 10, payout: Math.floor((bet * 25) / 10) };
    return { kind: 'pair', symbol: best[0], num: 1, den: 1, payout: bet };
  }
  return { kind: 'none', symbol: null, num: 0, den: 1, payout: 0 };
}

export function diceFaces(pick) {
  const faces = [1, 2, 3, 4, 5, 6];
  switch (pick?.type) {
    case 'face': return faces.filter((f) => f === pick.n);
    case 'over': return faces.filter((f) => f > pick.n);
    case 'under': return faces.filter((f) => f < pick.n);
    case 'even': return faces.filter((f) => f % 2 === 0);
    case 'odd': return faces.filter((f) => f % 2 === 1);
    case 'high': return faces.filter((f) => f >= 4);
    case 'low': return faces.filter((f) => f <= 3);
    default: return [];
  }
}

export function dicePayout(pick, roll, bet) {
  const faces = diceFaces(pick);
  const k = faces.length;
  if (!k || !faces.includes(roll)) return 0;
  return Math.floor((bet * 582) / (100 * k));
}

export function rouletteWins(pick, pocket) {
  if (typeof pick === 'number') return pick === pocket;
  if (pocket === 0) return false;
  switch (pick) {
    case 'red': return RED.has(pocket);
    case 'black': return !RED.has(pocket);
    case 'even': return pocket % 2 === 0;
    case 'odd': return pocket % 2 === 1;
    case 'low': return pocket <= 18;
    case 'high': return pocket >= 19;
    case 'd1': return pocket <= 12;
    case 'd2': return pocket >= 13 && pocket <= 24;
    case 'd3': return pocket >= 25;
    case 'c1': return pocket % 3 === 1;
    case 'c2': return pocket % 3 === 2;
    case 'c3': return pocket % 3 === 0;
    default: return false;
  }
}

export function rouletteReturn(pick) {
  if (typeof pick === 'number') return 36;
  if (/^[dc][123]$/.test(String(pick))) return 3;
  return 2;
}

export function crashPointX100(r, crashMax) {
  return Math.min(Math.floor(97_000_000 / r), Math.floor(crashMax) * 100);
}

export function multX100(ms) {
  return Math.floor(100 * 2 ** (Math.max(0, ms) / CRASH_DOUBLE_MS));
}

export function msFor(x100) {
  if (x100 <= 100) return 0;
  let ms = Math.ceil(CRASH_DOUBLE_MS * Math.log2(x100 / 100));
  while (multX100(ms) < x100) ms++;
  return ms;
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

export function cardText(n) {
  return `${RANKS[n % 13]}${SUITS[Math.floor(n / 13)]}`;
}

export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const n of cards) {
    const r = n % 13;
    if (r === 0) { aces++; total += 11; } else total += Math.min(10, r + 1);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

export function dealerPlays(cards, drawCard) {
  const out = [...cards];
  while (handTotal(out).total < 17) out.push(drawCard());
  return out;
}

const isNatural = (cards) => cards.length === 2 && handTotal(cards).total === 21;

const ALL_WORDS = new Set(['all', 'max', 'allin', 'all-in']);
const SKIP = new Set(['bet', 'bets', 'for', 'on', 'with', 'wager']);
const AMOUNT_RE = /^-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:k|m|b|t)?(?:coins?|🪙)?$/;
const AMOUNT_PLACES = { k: 3, m: 6, b: 9, t: 12 };
const cleanToken = (t) => String(t ?? '').trim().toLowerCase();
const amountLike = (w) => AMOUNT_RE.test(w) || ALL_WORDS.has(w) || w === 'half';

export function parseAmountToken(token) {
  const s = cleanToken(token).replace(/,/g, '').replace(/(?:coins?|🪙)$/, '');
  if (ALL_WORDS.has(s)) return { kind: 'all' };
  if (s === 'half') return { kind: 'half' };
  let n = null;
  const m = /^(\d+)(?:\.(\d+))?([kmbt])$/.exec(s);
  if (m) {
    const places = AMOUNT_PLACES[m[3]];
    const frac = m[2] || '';
    if (frac.length > places && /[1-9]/.test(frac.slice(places))) return null;
    n = Number(m[1]) * 10 ** places + Number(frac.slice(0, places).padEnd(places, '0'));
  } else if (/^\d+$/.test(s)) n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { kind: 'number', n };
}

export function resolveBet(amount, balance, { minBet, maxBet }) {
  if (!amount) return { error: 'none' };
  if (amount.kind === 'number') {
    if (amount.n < minBet) return { error: 'small' };
    if (!withinLimit(amount.n, maxBet)) return { error: 'big' };
    return { bet: amount.n };
  }
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  const want = amount.kind === 'all' ? bal : Math.floor(bal / 2);
  const bet = atMost(want, maxBet);
  if (bet < minBet) return { error: 'low', bet };
  return { bet };
}

function splitAmount(words) {
  for (let i = words.length - 1; i >= 0; i--) {
    if (amountLike(words[i])) return { raw: words[i], rest: words.filter((_, j) => j !== i) };
  }
  return { raw: null, rest: words };
}

const plainWord = (w) => clip(String(w).replace(/[<>@`*_~|]/g, ''), 30) || '?';

function unknownWord(kind, word) {
  const guess = didYouMean(word, PICK_WORDS[kind]);
  return { level: 'warn', title: "I didn't get that", body: `I don't know **${plainWord(word)}**.${guess.length ? ` Did you mean ${[...new Set(guess)].map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`${GAMES[kind].usage}\`.` };
}

const ERR = {
  side: { level: 'warn', title: 'Pick a side', body: 'Try `/coinflip heads 100` or `/coinflip tails 100`.' },
  dicePick: { level: 'warn', title: 'Pick what to bet on', body: 'Try `/dice 6 100`, `/dice over 3 100` or `/dice even 100`.' },
  roulettePick: { level: 'warn', title: 'Pick what to bet on', body: 'Try `/roulette red 100`, `/roulette 17 50` or `/roulette 2nd 100`.' },
  diceRange: { level: 'warn', title: "That roll can't happen", body: 'Over works with 1 to 5 and under with 2 to 6, like `/dice over 3 100`.' },
  diceFace: { level: 'warn', title: "That roll can't happen", body: 'A die has faces 1 to 6, like `/dice 6 100`.' },
  wheel: { level: 'warn', title: "That number isn't on the wheel", body: 'Pick a number from 0 to 36.' },
  amount: { level: 'warn', title: "That bet didn't work", body: 'Bets are whole numbers of coins, like `100`, `2k`, `half` or `all`.' },
};

const badTarget = (crashMax) => ({ level: 'warn', title: "That target didn't work", body: `Pick a cash-out target from 1.01x to ${crashMax}x, like \`/crash 100 2x\`.` });

function noAmount(kind) {
  const ex = GAMES[kind].example;
  return { level: 'warn', title: 'How much do you want to bet?', body: `Add an amount, like \`/${kind} ${ex}100\`, \`/${kind} ${ex}half\` or \`/${kind} ${ex}all\`.` };
}

function parseCoinflip(words) {
  let pick = null;
  const left = [];
  for (const w of words) {
    const s = own(SIDES, w);
    if (s) { pick ||= s; continue; }
    left.push(w);
  }
  const { raw, rest } = splitAmount(left);
  if (rest.length) return { error: unknownWord('coinflip', rest[0]) };
  if (!pick) return { error: ERR.side };
  return { pick, raw };
}

function parseDice(words) {
  let pick = null;
  const left = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^([<>])(\d+)$/.exec(w);
    if (m) { pick ||= { type: m[1] === '>' ? 'over' : 'under', n: Number(m[2]) }; continue; }
    if (/^(over|above|under|below|>|<)$/.test(w)) {
      const next = words[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) return { error: ERR.diceRange };
      pick ||= { type: /^(over|above|>)$/.test(w) ? 'over' : 'under', n: Number(next) };
      i++;
      continue;
    }
    const simple = own(DICE_SIMPLE, w);
    if (simple) { pick ||= { type: simple }; continue; }
    left.push(w);
  }
  const { raw, rest } = splitAmount(left);
  let face = null;
  for (const w of rest) {
    if (/^\d+$/.test(w) && face === null && !pick) { face = Number(w); continue; }
    return { error: unknownWord('dice', w) };
  }
  if (face !== null) {
    if (face < 1 || face > 6) return { error: ERR.diceFace };
    pick = { type: 'face', n: face };
  }
  if (!pick) return { error: ERR.dicePick };
  if (pick.type === 'over' && (pick.n < 1 || pick.n > 5)) return { error: ERR.diceRange };
  if (pick.type === 'under' && (pick.n < 2 || pick.n > 6)) return { error: ERR.diceRange };
  return { pick, raw };
}

function parseRoulette(words) {
  let pick = null;
  const left = [];
  for (const w of words) {
    const p = own(ROULETTE_WORDS, w);
    if (p !== undefined) { if (pick === null) pick = p; continue; }
    left.push(w);
  }
  const { raw, rest } = splitAmount(left);
  for (const w of rest) {
    if (/^\d+$/.test(w) && pick === null) {
      const n = Number(w);
      if (n > 36) return { error: ERR.wheel };
      pick = n;
      continue;
    }
    return { error: unknownWord('roulette', w) };
  }
  if (pick === null) return { error: ERR.roulettePick };
  return { pick, raw };
}

function parsePlain(kind) {
  return (words) => {
    const { raw, rest } = splitAmount(words);
    if (rest.length) return { error: unknownWord(kind, rest[0]) };
    return { pick: null, raw };
  };
}

function toX100(s) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(s))) return null;
  return Math.round(Number(s) * 100);
}

function parseCrash(words, cfg) {
  const crashMax = crashMaxOf(cfg);
  let target = null;
  const left = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^(\d+(?:\.\d+)?)x$/.exec(w) || /^x(\d+(?:\.\d+)?)$/.exec(w);
    if (m) {
      target = toX100(m[1]);
      if (target === null) return { error: badTarget(crashMax) };
      continue;
    }
    if (w === 'auto' || w === 'at' || w === 'cashout') {
      const n = /^x?(\d+(?:\.\d+)?)x?$/.exec(words[i + 1] || '');
      target = n ? toX100(n[1]) : null;
      if (target === null) return { error: badTarget(crashMax) };
      i++;
      continue;
    }
    left.push(w);
  }
  const { raw, rest } = splitAmount(left);
  if (rest.length) return { error: unknownWord('crash', rest[0]) };
  if (target !== null && (target < 101 || target > crashMax * 100)) return { error: badTarget(crashMax) };
  return { pick: null, target, raw };
}

const PARSERS = { coinflip: parseCoinflip, dice: parseDice, slots: parsePlain('slots'), blackjack: parsePlain('blackjack'), roulette: parseRoulette, crash: parseCrash };

export function parseArgs(kind, tokens, cfg = {}) {
  const words = [].concat(tokens || []).map(cleanToken).filter((w) => w && !SKIP.has(w));
  const r = PARSERS[kind](words, cfg);
  if (r.error) return r;
  if (!r.raw) return { error: noAmount(kind) };
  const amount = parseAmountToken(r.raw);
  if (!amount) return { error: ERR.amount };
  return { pick: r.pick ?? null, target: r.target ?? null, amount };
}

function pickTokens(kind, pick) {
  if (kind === 'coinflip') return [pick];
  if (kind === 'dice') {
    if (pick.type === 'face') return [String(pick.n)];
    if (pick.type === 'over' || pick.type === 'under') return [pick.type, String(pick.n)];
    return [pick.type];
  }
  if (kind === 'roulette') return typeof pick === 'number' ? [pick === 0 ? 'zero' : String(pick)] : [ROULETTE_TOKEN[pick]];
  return [];
}

function pickText(kind, pick) {
  if (kind === 'coinflip') return `**${pick === 'heads' ? 'Heads' : 'Tails'}**`;
  if (kind === 'dice') {
    if (pick.type === 'face') return `**${pick.n}**`;
    if (pick.type === 'over' || pick.type === 'under') return `**${pick.type} ${pick.n}**`;
    if (pick.type === 'high') return '**high (4-6)**';
    if (pick.type === 'low') return '**low (1-3)**';
    return `**${pick.type}**`;
  }
  if (kind === 'roulette') {
    if (typeof pick === 'number') return `**${pick}**`;
    const names = { red: '🔴 **red**', black: '⚫ **black**', even: '**even**', odd: '**odd**', low: '**low (1-18)**', high: '**high (19-36)**', d1: '**1st dozen (1-12)**', d2: '**2nd dozen (13-24)**', d3: '**3rd dozen (25-36)**', c1: '**column 1**', c2: '**column 2**', c3: '**column 3**' };
    return names[pick];
  }
  return '';
}

const pocketText = (n) => `${n === 0 ? '🟢' : RED.has(n) ? '🔴' : '⚫'} **${n}**`;

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { games: new Map(), busy: new Map(), starting: new Set(), cool: new Map(), finished: new Map(), timers: new Map(), timer: null, sweeping: null, disposed: false, draw: (min, max) => randomInt(min, max) };
    states.set(engine, s);
  }
  return s;
}

const draw = (engine, min, max) => stateOf(engine).draw(min, max);

function setTimer(engine, key, ms, fn) {
  const st = stateOf(engine);
  st.timers.set(key, { at: Date.now() + Math.max(0, ms), fn });
  arm(engine);
}

function clearTimer(engine, key) {
  stateOf(engine).timers.delete(key);
}

function arm(engine) {
  const st = stateOf(engine);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (st.disposed || !st.timers.size) return;
  let next = Infinity;
  for (const t of st.timers.values()) next = Math.min(next, t.at);
  st.timer = setTimeout(() => {
    st.timer = null;
    sweep(engine).catch((e) => engine.log.error('[casino] timer sweep failed:', e));
  }, Math.max(0, Math.min(next - Date.now(), 2_147_000_000)));
  st.timer.unref?.();
}

async function sweep(engine) {
  const st = stateOf(engine);
  if (st.sweeping) return st.sweeping;
  st.sweeping = (async () => {
    for (let guard = 0; guard < 1000; guard++) {
      const now = Date.now();
      let dueKey = null;
      let due = null;
      for (const [k, t] of st.timers) if (t.at <= now && (!due || t.at < due.at)) { due = t; dueKey = k; }
      if (!due) break;
      st.timers.delete(dueKey);
      try { await due.fn(); } catch (e) { engine.log.error('[casino] timer failed:', e); }
    }
  })();
  try { await st.sweeping; } finally { st.sweeping = null; arm(engine); }
  return undefined;
}

const blankTotals = () => ({ n: 0, wagered: 0, returned: 0, best: 0, bestBy: null });
const blankDoc = () => ({ open: {}, stats: {}, totals: blankTotals() });
function fixDoc(d) {
  const doc = d && typeof d === 'object' ? d : blankDoc();
  if (!doc.open || typeof doc.open !== 'object') doc.open = {};
  if (!doc.stats || typeof doc.stats !== 'object') doc.stats = {};
  if (!doc.totals || typeof doc.totals !== 'object') doc.totals = blankTotals();
  return doc;
}
function readDoc(engine, sid) {
  return fixDoc(engine.store.get(ID, sid, blankDoc()));
}
function writeDoc(engine, sid, fn) {
  return engine.store.update(ID, sid, (d) => {
    const doc = fixDoc(d);
    fn(doc);
    return doc;
  }, blankDoc());
}

function scheduleCheck(engine, sid, id, at) {
  const s = engine.scheduler;
  if (!s) return false;
  try {
    s.schedule({ kind: JOB, at: at ?? s.now() + CHECK_MS, serverId: sid, key: id, data: { id } });
    clearTimer(engine, `check:${id}`);
    return true;
  } catch (e) {
    engine.log.warn(`[casino] could not save a safety check for ${id}, so I'll keep checking it myself: ${e?.message}`);
    setTimer(engine, `check:${id}`, CHECK_MS, () => backupCheck(engine, sid, id));
    return false;
  }
}

async function backupCheck(engine, sid, id) {
  if (!readDoc(engine, sid).open[id]) return;
  const out = await cleanupJob({ serverId: sid, key: id, data: { id } }, engine);
  if (out?.reschedule && readDoc(engine, sid).open[id]) scheduleCheck(engine, sid, id);
}

function hasCheck(engine, sid, id) {
  try { return engine.scheduler.list({ kind: JOB, serverId: sid, key: id }).length > 0; } catch { return false; }
}

async function recoverOrphans(engine) {
  if (!engine.scheduler || typeof engine.store.keys !== 'function') return;
  const st = stateOf(engine);
  for (const sid of engine.store.keys(ID)) {
    for (const id of Object.keys(readDoc(engine, sid).open)) {
      if (st.disposed) return;
      if (st.games.has(id) || hasCheck(engine, sid, id)) continue;
      try { await backupCheck(engine, sid, id); } catch (e) { engine.log.error(`[casino] could not settle ${id} on start:`, e); }
    }
  }
}

function watch(engine, sid, id, record) {
  writeDoc(engine, sid, (d) => { d.open[id] = { ...(d.open[id] || {}), ...record }; });
  scheduleCheck(engine, sid, id);
}

function unwatch(engine, sid, id) {
  if (readDoc(engine, sid).open[id]) writeDoc(engine, sid, (d) => { delete d.open[id]; });
  try { engine.scheduler?.cancelWhere({ kind: JOB, serverId: sid, key: id }); } catch (e) { engine.log.debug('[casino] cancel check failed', e?.message); }
}

function economyFor(engine, sid) {
  const eco = engine.service('economy');
  if (!eco || typeof eco.take !== 'function' || typeof eco.add !== 'function' || typeof eco.balance !== 'function') return null;
  if (sid && !engine.settings.isEnabled(sid, 'economy')) return null;
  return eco;
}

function money(engine, sid, n) {
  let c = null;
  try { c = engine.service('economy')?.currency?.(sid); } catch { c = null; }
  const emoji = c && typeof c === 'object' && typeof c.emoji === 'string' && c.emoji ? c.emoji : '🪙';
  return `**${fmt(n)}** ${emoji}`;
}

function signedMoney(engine, sid, n) {
  const shown = n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '0';
  return money(engine, sid, 0).replace('**0**', `**${shown}**`);
}

async function balanceOf(eco, sid, uid) {
  if (!eco || typeof eco.balance !== 'function') return null;
  try { return Number(await eco.balance(sid, uid)) || 0; } catch { return null; }
}

const gameName = (kind) => GAMES[kind]?.name || 'Casino';

async function settle(engine, sid, id, payout, reason) {
  const cur = readDoc(engine, sid).open[id];
  if (!cur || !(Number(cur.held) > 0)) return null;
  let rec = null;
  writeDoc(engine, sid, (d) => {
    const o = d.open[id];
    if (o && Number(o.held) > 0) { rec = { ...o }; o.held = 0; }
  });
  if (!rec) return null;
  const held = Math.floor(Number(rec.held));
  const amount = payout === 'refund' ? held : Math.max(0, Math.floor(Number(payout) || 0));
  if (amount <= 0) return { ok: true, held, amount: 0 };
  const eco = engine.service('economy');
  try {
    if (!eco || typeof eco.add !== 'function') throw new Error('the Economy app is not loaded');
    await eco.add(sid, rec.uid, amount, reason);
    return { ok: true, held, amount };
  } catch (e) {
    engine.log.warn(`[casino] could not pay ${amount} coins for ${id} yet: ${e?.message}`);
    writeDoc(engine, sid, (d) => {
      d.open[id] = { ...(d.open[id] || rec), kind: 'owed', game: rec.game || rec.kind, uid: rec.uid, held: amount, at: rec.kind === 'owed' ? rec.at : Date.now() };
    });
    return { ok: false, held, amount };
  }
}

function owe(engine, sid, uid, kind, amount, channelId) {
  const id = newId();
  writeDoc(engine, sid, (d) => { d.open[id] = { kind: 'owed', game: kind, uid, channelId, messageId: null, at: Date.now(), held: amount }; });
  scheduleCheck(engine, sid, id);
}

function recordStats(engine, sid, uid, kind, stake, payout) {
  const now = Date.now();
  writeDoc(engine, sid, (d) => {
    const s = d.stats;
    if (!Object.hasOwn(s, uid)) {
      const ids = Object.keys(s);
      if (ids.length >= MAX_STAT_USERS) {
        let oldest = null;
        for (const k of ids) if (k !== uid && (oldest === null || (Number(s[k]?.seen) || 0) < (Number(s[oldest]?.seen) || 0))) oldest = k;
        if (oldest !== null) delete s[oldest];
      }
      s[uid] = { n: 0, wagered: 0, returned: 0, best: 0, games: {}, seen: now };
    }
    const u = s[uid];
    const profit = payout - stake;
    u.n = (Number(u.n) || 0) + 1;
    u.wagered = (Number(u.wagered) || 0) + stake;
    u.returned = (Number(u.returned) || 0) + payout;
    if (profit > (Number(u.best) || 0)) u.best = profit;
    u.seen = now;
    if (!u.games || typeof u.games !== 'object') u.games = {};
    const g = (u.games[kind] ||= { n: 0, wagered: 0, returned: 0 });
    g.n = (Number(g.n) || 0) + 1;
    g.wagered = (Number(g.wagered) || 0) + stake;
    g.returned = (Number(g.returned) || 0) + payout;
    const t = d.totals;
    t.n = (Number(t.n) || 0) + 1;
    t.wagered = (Number(t.wagered) || 0) + stake;
    t.returned = (Number(t.returned) || 0) + payout;
    if (profit > (Number(t.best) || 0)) { t.best = profit; t.bestBy = uid; }
  });
}

function serverGames(st, sid) {
  return [...st.games.values()].filter((g) => g.sid === sid);
}

function freeGame(engine, g) {
  const st = stateOf(engine);
  st.games.delete(g.id);
  const key = busyKey(g.sid, g.uid);
  if (st.busy.get(key) === g.id) st.busy.delete(key);
  for (const t of ['idle', 'tick', 'end']) clearTimer(engine, `${t}:${g.id}`);
}

function pruneFinished(st) {
  const now = Date.now();
  for (const [k, f] of st.finished) if (now - f.endedAt > FINISHED_KEEP_MS) st.finished.delete(k);
  while (st.finished.size > 500) st.finished.delete(st.finished.keys().next().value);
}

function pruneCool(st, maxMs) {
  if (st.cool.size < 2000) return;
  const now = Date.now();
  for (const [k, at] of st.cool) if (now - at > maxMs) st.cool.delete(k);
  while (st.cool.size > 2000) st.cool.delete(st.cool.keys().next().value);
}

function editMessage(engine, channelId, messageId, view) {
  if (!channelId || !messageId) return Promise.resolve(null);
  return engine.budget.edit({ channelId, messageId, content: view.content ?? '', opts: { embeds: view.embeds, components: view.components } })
    .catch((e) => { engine.log.debug('[casino] could not edit a game message', e?.message); return null; });
}

async function send(ctx, view, mode) {
  if (mode === 'update') {
    await ctx.update(view);
    return ctx.source?.message_id ?? null;
  }
  const sent = await ctx.reply({ ...view, open: true });
  return (sent?.message ?? sent)?.id ?? null;
}

function say(ctx, e) {
  if (e.level === 'info') return ctx.info(e.title, e.body);
  return ctx.warn(e.title, e.body);
}

function notYours(ctx, uid) {
  return ctx.ephemeral({ embeds: [dialog.denied(null, { title: "That's not your game", body: `Only ${mention(uid)} can press these. Start your own with **/casino**.` })] });
}

const outOfDate = (ctx) => ctx.info('That button is out of date', 'Use the buttons on the message as it is now.');

function wholeNumber(text) {
  const s = String(text ?? '').trim().replace(/,/g, '').replace(/\s*(coins?|🪙|s|sec|secs|seconds?|x)$/i, '');
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

const SETTING_RANGES = {
  minBet: [10, MAX_BET_LIMIT],
  maxBet: [10, MAX_BET_LIMIT],
  cooldownSeconds: [0, 300],
  crashMax: [2, 100],
};

const UNCAPPED = new Set(['maxBet']);

const SETTING_HELP = {
  minBet: 'Use a whole number from 10 up, like `/casino minbet 10`.',
  maxBet: limitHelp('no biggest bet at all', { min: 10, example: '/casino maxbet 500' }),
  cooldownSeconds: 'Use a whole number of seconds from 0 to 300, like `/casino cooldown 5`. 0 turns the wait off.',
  crashMax: 'Use a whole number from 2 to 100, like `/casino crashmax 50`.',
};

function inRange(key, raw) {
  const [lo, hi] = SETTING_RANGES[key];
  if (key === 'minBet' || key === 'maxBet') return parseLimit(raw, { min: lo, max: hi, unlimited: UNCAPPED.has(key) });
  const n = typeof raw === 'number' ? raw : wholeNumber(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

function inEffect(engine, sid, key, all) {
  if (all && typeof all === 'object' && Object.hasOwn(all, key)) {
    const n = inRange(key, all[key]);
    if (n !== null) return n;
  }
  const saved = inRange(key, cfgOf(engine, sid)[key]);
  return saved ?? (key === 'minBet' ? 10 : 1000);
}

export function checkSetting(engine, sid, key, raw, all = null) {
  if (!Object.hasOwn(SETTING_RANGES, key)) return rejectValue("That setting doesn't exist.");
  const n = inRange(key, raw);
  if (n === null) return rejectValue(SETTING_HELP[key]);
  if (key === 'minBet') {
    const max = inEffect(engine, sid, 'maxBet', all);
    if (!withinLimit(n, max)) return rejectValue(`The smallest bet can't be bigger than the biggest bet (${fmt(max)}).`);
  }
  if (key === 'maxBet' && !isUnlimited(n)) {
    const min = inEffect(engine, sid, 'minBet', all);
    if (n < min) return rejectValue(`The biggest bet can't be smaller than the smallest bet (${fmt(min)}).`);
  }
  return acceptValue(storeLimit(n));
}

function limitsOf(cfg) {
  const minBet = inRange('minBet', cfg.minBet) ?? 10;
  const saved = inRange('maxBet', cfg.maxBet) ?? 1000;
  const maxBet = isUnlimited(saved) ? UNLIMITED : Math.max(minBet, saved);
  return { minBet, maxBet };
}

function maxBetText(engine, sid, maxBet) {
  return limitText(maxBet, { word: '**any amount**', fmt: (n) => money(engine, sid, n) });
}

function betRangeText(engine, sid, lim) {
  return isUnlimited(lim.maxBet)
    ? `${money(engine, sid, lim.minBet)} and up, with no limit`
    : `${money(engine, sid, lim.minBet)} to ${money(engine, sid, lim.maxBet)}`;
}

function crashMaxOf(cfg) {
  return inRange('crashMax', cfg?.crashMax) ?? 50;
}

function cooldownLeft(st, key, cfg) {
  const secs = inRange('cooldownSeconds', cfg.cooldownSeconds) ?? 0;
  if (!secs) return 0;
  const at = st.cool.get(key);
  if (!at) return 0;
  const left = secs * 1000 - (Date.now() - at);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function busyText(kind) {
  return kind === 'crash'
    ? 'Finish your crash round first, or type **/casino end** to cash out now.'
    : 'Finish your blackjack hand first, or type **/casino end** to stand.';
}

async function startGame(ctx, kind, tokens, mode = 'reply', extra = {}) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const sid = ctx.serverId;
  const uid = ctx.userId;
  const eco = economyFor(engine, sid);
  if (!eco) return ctx.info('The casino needs Economy', 'Casino games use server coins from the **Economy** app. An admin can install it with **/apps**.');
  const cfg = cfgOf(engine, sid);
  if (cfg[kind] === false) {
    if (GAME_KEYS.every((k) => cfg[k] === false)) return ctx.info('The casino is closed', 'An admin turned every game off.');
    return ctx.info(`${gameName(kind)} is off here`, 'An admin turned this game off. Try another one with **/casino**.');
  }
  const parsed = parseArgs(kind, tokens, cfg);
  if (parsed.error) return extra.forged ? outOfDate(ctx) : say(ctx, parsed.error);
  const key = busyKey(sid, uid);
  const wait = cooldownLeft(st, key, cfg);
  if (wait > 0) return ctx.info('Take a breather', `You can play again in ${plural(wait, 'second')}.`);
  const live = st.busy.get(key);
  if (live && st.games.has(live)) return ctx.info("You're already playing", busyText(st.games.get(live).kind));
  if (st.starting.has(key)) return ctx.info('One moment', 'Your last game is still starting.');
  if (LIVE_KINDS.has(kind)) {
    const here = serverGames(st, sid);
    if (here.length >= MAX_LIVE) return ctx.warn('Lots of games going', `There are already ${MAX_LIVE} live games here. Try again when one ends.`);
    if (kind === 'crash' && here.filter((g) => g.kind === 'crash').length >= MAX_CRASH) return ctx.warn('Lots of games going', `There are already ${MAX_CRASH} crash rounds here. Try again when one ends.`);
  }
  st.starting.add(key);
  try {
    const lim = limitsOf(cfg);
    const bal = await balanceOf(eco, sid, uid);
    const r = resolveBet(parsed.amount, bal ?? 0, lim);
    if (r.error === 'small') return ctx.warn('That bet is too small', `The smallest bet here is ${money(engine, sid, lim.minBet)}.`);
    if (r.error === 'big') return ctx.warn('That bet is too big', `The biggest bet here is ${maxBetText(engine, sid, lim.maxBet)}.`);
    if (r.error === 'low') return ctx.warn('Not enough coins', `You have ${money(engine, sid, bal ?? 0)} and the smallest bet is ${money(engine, sid, lim.minBet)}. Get more with **/daily**.`);
    const bet = r.bet;
    if (kind === 'crash' && parsed.target && Math.floor((bet * parsed.target) / 100) <= bet) return ctx.warn("That target can't win", `With a bet of ${money(engine, sid, bet)}, a ${fmtX(parsed.target)} cash-out only gives your bet back. Bet more or pick a higher target.`);
    if (bal !== null && bal < bet) return ctx.warn('Not enough coins', `You have ${money(engine, sid, bal)}, so you can't bet ${money(engine, sid, bet)}. Get more with **/daily**.`);
    let after;
    try {
      after = await eco.take(sid, uid, bet, `${gameName(kind)} bet`);
    } catch (e) {
      engine.log.warn(`[casino] could not take a bet: ${e?.message}`);
      return ctx.warn("I couldn't take the bet", 'Nothing was taken. Try again in a moment.');
    }
    if (after === null || after === undefined || after === false) {
      const now = await balanceOf(eco, sid, uid);
      return ctx.warn('Not enough coins', `You have ${money(engine, sid, now ?? 0)}, so you can't bet ${money(engine, sid, bet)}. Get more with **/daily**.`);
    }
    st.cool.set(key, Date.now());
    pruneCool(st, 300_000);
    if (kind === 'blackjack') return await startBlackjack(ctx, bet, mode);
    if (kind === 'crash') return await startCrash(ctx, bet, parsed.target, mode);
    return await playInstant(ctx, kind, parsed.pick, bet, mode);
  } finally {
    st.starting.delete(key);
  }
}

function instantOutcome(engine, kind, pick, bet) {
  if (kind === 'coinflip') {
    const side = draw(engine, 0, 2) === 0 ? 'heads' : 'tails';
    const payout = side === pick ? Math.floor((bet * 195) / 100) : 0;
    return { payout, shown: `The coin landed on **${side === 'heads' ? 'Heads' : 'Tails'}**.` };
  }
  if (kind === 'dice') {
    const roll = draw(engine, 1, 7);
    return { payout: dicePayout(pick, roll, bet), shown: `The die rolled **${roll}**.` };
  }
  if (kind === 'slots') {
    const keys = [0, 1, 2].map(() => reelSymbol(draw(engine, 0, 32)));
    const sp = slotPayout(keys, bet);
    return { payout: sp.payout, pair: sp.kind === 'pair' && sp.num === sp.den, shown: `[ ${keys.map((k) => REEL_BY_KEY[k].emoji).join(' | ')} ]` };
  }
  const pocket = draw(engine, 0, 37);
  const payout = rouletteWins(pick, pocket) ? bet * rouletteReturn(pick) : 0;
  return { payout, shown: `The ball landed on ${pocketText(pocket)}.` };
}

function againId(kind, uid, pick, bet) {
  try { return cid('again', kind, uid, ...pickTokens(kind, pick), bet); } catch { return null; }
}

function instantView(engine, sid, r) {
  const g = GAMES[r.kind];
  const lines = [];
  lines.push(r.kind === 'slots' ? `${mention(r.uid)} bet ${money(engine, sid, r.bet)}` : `${mention(r.uid)} bet ${money(engine, sid, r.bet)} on ${pickText(r.kind, r.pick)}`);
  lines.push('', r.out.shown, '');
  let color = 'muted';
  const mult = `${Math.floor((r.out.payout * 100) / r.bet) / 100}x`;
  if (r.out.payout > r.bet) { lines.push(`🎉 You won ${money(engine, sid, r.out.payout)} (${mult})`); color = 'ok'; } else if (r.out.payout === r.bet) { lines.push(r.out.pair ? 'Pair: your bet back' : 'Your bet came back'); color = 'casino'; } else if (r.out.payout > 0) { lines.push(`You got back ${money(engine, sid, r.out.payout)} (${mult})`); color = 'casino'; } else lines.push(`You lost ${money(engine, sid, r.bet)}`);
  if (r.balance !== null && r.balance !== undefined) lines.push(`Balance: ${money(engine, sid, r.balance)}`);
  const again = againId(r.kind, r.uid, r.pick, r.bet);
  return {
    content: '',
    embeds: [card({ title: `${g.icon} ${g.name}`, body: lines.join('\n'), color, footer: again ? 'Press Again to play the same bet · just for fun with server coins' : FUN_NOTE })],
    components: again ? [row(button('Again', again, 'primary', '🔁'))] : [],
  };
}

async function playInstant(ctx, kind, pick, bet, mode) {
  const { engine } = ctx;
  const sid = ctx.serverId;
  const uid = ctx.userId;
  const out = instantOutcome(engine, kind, pick, bet);
  let paid = true;
  if (out.payout > 0) {
    try {
      const eco = engine.service('economy');
      if (!eco || typeof eco.add !== 'function') throw new Error('the Economy app is not loaded');
      await eco.add(sid, uid, out.payout, `${gameName(kind)} win`);
    } catch (e) {
      engine.log.error(`[casino] could not pay a ${kind} win:`, e);
      paid = false;
      owe(engine, sid, uid, kind, out.payout, ctx.channelId);
    }
  }
  recordStats(engine, sid, uid, kind, bet, out.payout);
  const balance = await balanceOf(engine.service('economy'), sid, uid);
  const view = instantView(engine, sid, { kind, uid, pick, bet, out, balance });
  await send(ctx, view, mode);
  if (!paid) await ctx.warn("I couldn't pay you yet", `You won ${money(engine, sid, out.payout)}. I'll add it to your wallet in a few minutes.`);
  return undefined;
}

function newLive(ctx, kind, bet, mode) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const g = {
    id: newId(), sid: ctx.serverId, uid: ctx.userId, kind, channelId: ctx.channelId,
    messageId: mode === 'update' ? ctx.source?.message_id ?? null : null,
    bet, held: bet, phase: 'playing', createdAt: Date.now(), lastMoveAt: Date.now(), result: null, paid: null, balance: null,
  };
  st.games.set(g.id, g);
  st.busy.set(busyKey(g.sid, g.uid), g.id);
  watch(engine, g.sid, g.id, { kind, uid: g.uid, channelId: g.channelId, messageId: g.messageId, at: Date.now(), held: bet });
  return g;
}

function setMessage(engine, g, messageId) {
  if (!messageId || g.messageId === messageId) return;
  g.messageId = messageId;
  writeDoc(engine, g.sid, (d) => { if (d.open[g.id]) d.open[g.id].messageId = messageId; });
}

async function endGame(engine, g, result) {
  if (g.phase === 'over') return viewOf(engine, g);
  const st = stateOf(engine);
  g.phase = 'over';
  g.result = result;
  freeGame(engine, g);
  const cancel = result.kind === 'cancel';
  const reason = cancel ? `${gameName(g.kind)} bet back` : `${gameName(g.kind)} win`;
  const res = await settle(engine, g.sid, g.id, cancel ? 'refund' : result.payout, reason);
  g.paid = res;
  if (!res || res.ok) unwatch(engine, g.sid, g.id);
  if (!cancel && res) recordStats(engine, g.sid, g.uid, g.kind, res.held, res.amount);
  if (!cancel) {
    pruneFinished(st);
    st.finished.set(g.id, { kind: g.kind, sid: g.sid, uid: g.uid, bet: g.bet, target: g.target ?? null, endedAt: Date.now() });
  }
  g.balance = await balanceOf(engine.service('economy'), g.sid, g.uid);
  return viewOf(engine, g);
}

const viewOf = (engine, g) => (g.kind === 'blackjack' ? bjView(engine, g) : crashView(engine, g));

function cardsText(cards) {
  return cards.map(cardText).join(' ');
}

function totalText(cards) {
  const t = handTotal(cards);
  if (isNatural(cards)) return 'blackjack';
  if (t.total > 21) return `${t.total} bust`;
  return t.soft ? `soft ${t.total}` : String(t.total);
}

function payLine(engine, g) {
  if (g.paid && g.paid.ok === false) return `\n⚠️ I couldn't pay you yet. I'll add ${money(engine, g.sid, g.paid.amount)} to your wallet in a few minutes.`;
  return '';
}

function bjResultText(engine, g) {
  const r = g.result;
  const m = (n) => money(engine, g.sid, n);
  switch (r.kind) {
    case 'blackjack': return `🎉 Blackjack! You won ${m(r.payout)}.`;
    case 'win': return `🏆 You win! You got ${m(r.payout)}.`;
    case 'dealerbust': return `💥 The dealer went bust. You got ${m(r.payout)}.`;
    case 'push': return `🤝 Push. Your ${m(r.payout)} came back.`;
    case 'bust': return `💥 Bust! You lost ${m(g.held)}.`;
    case 'dealerbj': return `The dealer has blackjack. You lost ${m(g.held)}.`;
    case 'lose': return `The dealer wins. You lost ${m(g.held)}.`;
    case 'cancel': return `🚫 Cancelled: ${r.reason}. Your bet of ${m(g.held)} went back.`;
    default: return '';
  }
}

function bjView(engine, g) {
  const over = g.phase === 'over';
  const lines = [`${mention(g.uid)} bet ${money(engine, g.sid, g.held)}${g.doubled ? ' (doubled)' : ''}`, ''];
  if (over) lines.push(`**Dealer** ${cardsText(g.dealer)} · ${totalText(g.dealer)}`);
  else lines.push(`**Dealer** 🂠 ${cardText(g.dealer[0])} (shows ${handTotal([g.dealer[0]]).total})`);
  lines.push(`**You** ${cardsText(g.player)} · ${totalText(g.player)}`);
  const components = [];
  let footer;
  if (over) {
    lines.push('', bjResultText(engine, g) + payLine(engine, g));
    if (g.balance !== null && g.balance !== undefined) lines.push(`Balance: ${money(engine, g.sid, g.balance)}`);
    if (g.result.kind !== 'cancel') {
      components.push(row(button('New hand', cid('bjagain', g.id, g.uid), 'primary', '🔁')));
      footer = 'Press New hand to play again for the same bet';
    } else footer = false;
  } else {
    const buttons = [button('Hit', cid('bj', g.id, g.uid, 'hit'), 'primary', '👆'), button('Stand', cid('bj', g.id, g.uid, 'stand'), 'secondary', '✋')];
    if (g.player.length === 2 && !g.doubled) buttons.push(button('Double', cid('bj', g.id, g.uid, 'double'), 'success', '✌️'));
    components.push(row(buttons));
    footer = 'Hit, Stand or Double · auto-stands after 2 minutes of no moves';
  }
  const color = !over ? 'casino' : ['blackjack', 'win', 'dealerbust'].includes(g.result.kind) ? 'ok' : g.result.kind === 'push' || g.result.kind === 'cancel' ? 'casino' : 'muted';
  return { content: '', embeds: [card({ title: '🃏 Blackjack', body: lines.join('\n'), color, footer })], components };
}

async function startBlackjack(ctx, bet, mode) {
  const { engine } = ctx;
  const g = newLive(ctx, 'blackjack', bet, mode);
  g.player = [];
  g.dealer = [];
  g.doubled = false;
  const next = () => draw(engine, 0, 52);
  g.player.push(next());
  g.dealer.push(next());
  g.player.push(next());
  g.dealer.push(next());
  const pn = isNatural(g.player);
  const dn = isNatural(g.dealer);
  if (pn || dn) {
    const result = pn && dn ? { kind: 'push', payout: bet } : pn ? { kind: 'blackjack', payout: bet + Math.floor((bet * 3) / 2) } : { kind: 'dealerbj', payout: 0 };
    const view = await endGame(engine, g, result);
    const id = await send(ctx, view, mode);
    g.messageId = id || g.messageId;
    return undefined;
  }
  startIdle(engine, g);
  let id;
  try {
    id = await send(ctx, bjView(engine, g), mode);
  } catch (e) {
    await endGame(engine, g, { kind: 'cancel', reason: 'the game could not be posted' });
    throw e;
  }
  setMessage(engine, g, id);
  return undefined;
}

function startIdle(engine, g) {
  g.lastMoveAt = Date.now();
  setTimer(engine, `idle:${g.id}`, IDLE_MS, () => onIdle(engine, g.id));
}

async function onIdle(engine, gid) {
  const g = stateOf(engine).games.get(gid);
  if (!g || g.phase !== 'playing' || g.kind !== 'blackjack') return;
  const left = IDLE_MS - (Date.now() - g.lastMoveAt);
  if (left > 0) { setTimer(engine, `idle:${gid}`, left, () => onIdle(engine, gid)); return; }
  if (g.doubling) { setTimer(engine, `idle:${gid}`, 1000, () => onIdle(engine, gid)); return; }
  const view = await standHand(engine, g);
  await editMessage(engine, g.channelId, g.messageId, view);
}

function standHand(engine, g) {
  g.dealer = dealerPlays(g.dealer, () => draw(engine, 0, 52));
  const p = handTotal(g.player).total;
  const d = handTotal(g.dealer).total;
  let result;
  if (d > 21) result = { kind: 'dealerbust', payout: g.held * 2 };
  else if (p > d) result = { kind: 'win', payout: g.held * 2 };
  else if (p === d) result = { kind: 'push', payout: g.held };
  else result = { kind: 'lose', payout: 0 };
  return endGame(engine, g, result);
}

async function lostGame(ctx, gid) {
  const { engine } = ctx;
  if (messageInUse(engine, ctx.source?.message_id)) return outOfDate(ctx);
  const rec = readDoc(engine, ctx.serverId).open[gid];
  if (!rec || rec.kind === 'owed' || !(Number(rec.held) > 0) || stateOf(engine).finished.has(gid)) return ctx.info('That game is over', 'Start a new one with **/casino**.');
  const res = await settle(engine, ctx.serverId, gid, 'refund', `${gameName(rec.kind)} bet back`);
  if (!res || res.ok) unwatch(engine, ctx.serverId, gid);
  return ctx.update(lostView());
}

function lostView() {
  return { content: '', embeds: [card({ title: '🎰 Game cancelled', body: 'I restarted, so this game was cancelled. Your bet went back to you.\nStart a new one with **/casino**.', color: 'muted', footer: false })], components: [] };
}

function messageInUse(engine, messageId) {
  if (!messageId) return false;
  for (const g of stateOf(engine).games.values()) if (g.messageId === messageId) return true;
  return false;
}

async function bjAction(ctx) {
  const { engine } = ctx;
  const [gid, , action] = ctx.argv;
  const g = stateOf(engine).games.get(gid);
  if (!g) return lostGame(ctx, gid);
  if (g.sid !== ctx.serverId || g.kind !== 'blackjack') return outOfDate(ctx);
  if (g.uid !== ctx.userId) return notYours(ctx, g.uid);
  if (g.phase !== 'playing') return ctx.info('That game is over', 'Start a new one with **/casino**.');
  if (g.doubling) return ctx.info('One moment', 'Your double is still going through.');
  if (action === 'hit') {
    g.player.push(draw(engine, 0, 52));
    const t = handTotal(g.player).total;
    if (t > 21) return ctx.update(await endGame(engine, g, { kind: 'bust', payout: 0 }));
    if (t === 21) return ctx.update(await standHand(engine, g));
    startIdle(engine, g);
    return ctx.update(bjView(engine, g));
  }
  if (action === 'stand') return ctx.update(await standHand(engine, g));
  if (action === 'double') return doubleDown(ctx, g);
  return outOfDate(ctx);
}

async function doubleDown(ctx, g) {
  const { engine } = ctx;
  if (g.player.length !== 2 || g.doubled) return ctx.info("You can't double now", 'You can only double on your first two cards.');
  const eco = economyFor(engine, g.sid);
  if (!eco) return ctx.info("You can't double now", "Economy is off now, so you can't double. Hit or Stand to finish.");
  g.doubling = true;
  let after = null;
  let failed = false;
  try {
    after = await eco.take(g.sid, g.uid, g.bet, 'Blackjack double');
  } catch (e) {
    engine.log.warn(`[casino] could not take a double: ${e?.message}`);
    failed = true;
  } finally {
    g.doubling = false;
  }
  const took = !failed && after !== null && after !== undefined && after !== false;
  if (g.phase !== 'playing') {
    if (took) {
      try { await eco.add(g.sid, g.uid, g.bet, 'Blackjack double back'); } catch (e) { engine.log.error('[casino] could not give a double back:', e); owe(engine, g.sid, g.uid, 'blackjack', g.bet, g.channelId); }
    }
    return ctx.info('That game is over', 'Start a new one with **/casino**.');
  }
  if (failed) return ctx.warn("I couldn't take the bet", 'Nothing was taken. Try again in a moment.');
  if (!took) {
    const bal = await balanceOf(eco, g.sid, g.uid);
    return ctx.warn('Not enough coins to double', `Doubling needs another ${money(engine, g.sid, g.bet)}. You have ${money(engine, g.sid, bal ?? 0)}.`);
  }
  g.doubled = true;
  g.held += g.bet;
  writeDoc(engine, g.sid, (d) => { if (d.open[g.id]) d.open[g.id].held = (Number(d.open[g.id].held) || 0) + g.bet; });
  g.player.push(draw(engine, 0, 52));
  if (handTotal(g.player).total > 21) return ctx.update(await endGame(engine, g, { kind: 'bust', payout: 0 }));
  return ctx.update(await standHand(engine, g));
}

function crashResultText(engine, g) {
  const r = g.result;
  const m = (n) => money(engine, g.sid, n);
  if (r.kind === 'cashout' && r.payout <= g.held) return `💰 Cashed out at **${fmtX(r.atX100)}** · your bet of ${m(r.payout)} came back\nIt crashed at ${fmtX(g.crashX100)}.`;
  if (r.kind === 'cashout') return `💰 Cashed out at **${fmtX(r.atX100)}** · you won ${m(r.payout)}\nIt crashed at ${fmtX(g.crashX100)}.`;
  if (r.kind === 'cap') return `💰 Reached the top of **${fmtX(r.atX100)}** and cashed out · you won ${m(r.payout)}`;
  if (r.kind === 'bust') return `💥 Crashed at **${fmtX(g.crashX100)}**. You lost ${m(g.held)}.`;
  if (r.kind === 'cancel') return `🚫 Cancelled: ${r.reason}. Your bet of ${m(g.held)} went back.`;
  return '';
}

function crashView(engine, g) {
  const over = g.phase === 'over';
  const lines = [];
  if (!over) {
    const m = g.startedAt ? Math.min(multX100(Date.now() - g.startedAt), g.capX100) : 100;
    lines.push(`${mention(g.uid)} · Bet: ${money(engine, g.sid, g.bet)} · Multiplier **${fmtX(m)}**`);
    lines.push(`Cash out now for ${money(engine, g.sid, Math.floor((g.bet * m) / 100))}`);
    if (g.target) lines.push(`🎯 Auto cash-out at **${fmtX(g.target)}**`);
    lines.push(`-# It cashes out by itself at ${fmtX(g.capX100)}.`);
    return {
      content: '',
      embeds: [card({ title: '🚀 Crash', body: lines.join('\n'), color: 'casino', footer: 'Cash out before it crashes · the multiplier updates every 2 seconds' })],
      components: [row(button('Cash out', cid('cash', g.id, g.uid), 'success', '💰'))],
    };
  }
  lines.push(`${mention(g.uid)} · Bet: ${money(engine, g.sid, g.bet)}${g.target ? ` · auto cash-out ${fmtX(g.target)}` : ''}`, '');
  lines.push(crashResultText(engine, g) + payLine(engine, g));
  if (g.balance !== null && g.balance !== undefined) lines.push(`Balance: ${money(engine, g.sid, g.balance)}`);
  const cancel = g.result.kind === 'cancel';
  const back = (g.result.kind === 'cashout' || g.result.kind === 'cap') && g.result.payout <= g.held;
  const won = (g.result.kind === 'cashout' || g.result.kind === 'cap') && !back;
  return {
    content: '',
    embeds: [card({ title: '🚀 Crash', body: lines.join('\n'), color: won ? 'ok' : cancel || back ? 'casino' : 'muted', footer: cancel ? false : 'Press Play again for another round with the same bet' })],
    components: cancel ? [] : [row(button('Play again', cid('crashagain', g.id, g.uid), 'primary', '🔁'))],
  };
}

function instantBustView(engine, sid, uid, bet, target, balance) {
  const lines = [`${mention(uid)} · Bet: ${money(engine, sid, bet)}${target ? ` · auto cash-out ${fmtX(target)}` : ''}`, '', `💥 Crashed at **1.00x** right away. You lost ${money(engine, sid, bet)}.`];
  if (balance !== null && balance !== undefined) lines.push(`Balance: ${money(engine, sid, balance)}`);
  return { content: '', embeds: [card({ title: '🚀 Crash', body: lines.join('\n'), color: 'muted', footer: 'Start another round with /crash' })], components: [] };
}

async function startCrash(ctx, bet, target, mode) {
  const { engine } = ctx;
  const cfg = cfgOf(engine, ctx.serverId);
  const crashMax = crashMaxOf(cfg);
  const r = draw(engine, 1, 1_000_001);
  const crashX100 = crashPointX100(r, crashMax);
  if (crashX100 < 100) {
    recordStats(engine, ctx.serverId, ctx.userId, 'crash', bet, 0);
    const balance = await balanceOf(engine.service('economy'), ctx.serverId, ctx.userId);
    await send(ctx, instantBustView(engine, ctx.serverId, ctx.userId, bet, target, balance), mode);
    return undefined;
  }
  const g = newLive(ctx, 'crash', bet, mode);
  g.crashX100 = crashX100;
  g.capX100 = crashMax * 100;
  g.target = target || null;
  g.startedAt = null;
  g.edits = 0;
  let id;
  try {
    id = await send(ctx, crashView(engine, g), mode);
  } catch (e) {
    await endGame(engine, g, { kind: 'cancel', reason: 'the round could not be posted' });
    throw e;
  }
  setMessage(engine, g, id);
  if (g.phase !== 'playing') return undefined;
  g.startedAt = Date.now();
  setTimer(engine, `end:${g.id}`, msFor(crashStop(g)), () => crashEnd(engine, g.id));
  setTimer(engine, `tick:${g.id}`, CRASH_TICK_MS, () => crashTick(engine, g.id));
  return undefined;
}

function crashStop(g) {
  return g.target ? Math.min(g.crashX100, g.target) : g.crashX100;
}

function crashFinish(g, m) {
  if (g.target && g.target <= g.crashX100 && m >= g.target) return { kind: 'cashout', atX100: g.target, payout: Math.floor((g.bet * g.target) / 100) };
  if (m > g.crashX100) {
    if (g.crashX100 >= g.capX100) return { kind: 'cap', atX100: g.capX100, payout: Math.floor((g.bet * g.capX100) / 100) };
    return { kind: 'bust', payout: 0 };
  }
  if (m >= g.capX100) return { kind: 'cap', atX100: g.capX100, payout: Math.floor((g.bet * g.capX100) / 100) };
  return { kind: 'cashout', atX100: m, payout: Math.floor((g.bet * m) / 100) };
}

async function crashEnd(engine, gid) {
  const g = stateOf(engine).games.get(gid);
  if (!g || g.phase !== 'playing' || g.kind !== 'crash' || !g.startedAt) return;
  const stopMs = msFor(crashStop(g));
  const elapsed = Date.now() - g.startedAt;
  if (elapsed < stopMs) { setTimer(engine, `end:${gid}`, stopMs - elapsed, () => crashEnd(engine, gid)); return; }
  const stop = crashStop(g);
  let result;
  if (g.target && g.target <= g.crashX100) result = { kind: 'cashout', atX100: g.target, payout: Math.floor((g.bet * g.target) / 100) };
  else if (g.crashX100 >= g.capX100) result = { kind: 'cap', atX100: g.capX100, payout: Math.floor((g.bet * g.capX100) / 100) };
  else result = { kind: 'bust', payout: 0, atX100: stop };
  const view = await endGame(engine, g, result);
  await editMessage(engine, g.channelId, g.messageId, view);
}

async function crashTick(engine, gid) {
  const g = stateOf(engine).games.get(gid);
  if (!g || g.phase !== 'playing' || g.kind !== 'crash') return;
  if (g.edits >= CRASH_MAX_EDITS) return;
  if (Date.now() - g.startedAt >= msFor(crashStop(g))) return;
  g.edits++;
  editMessage(engine, g.channelId, g.messageId, crashView(engine, g));
  if (g.edits < CRASH_MAX_EDITS) setTimer(engine, `tick:${gid}`, CRASH_TICK_MS, () => crashTick(engine, gid));
}

async function cashOut(ctx) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const [gid] = ctx.argv;
  const g = st.games.get(gid);
  if (g && (g.sid !== ctx.serverId || g.kind !== 'crash')) return outOfDate(ctx);
  if (!g) {
    pruneFinished(st);
    if (st.finished.has(gid)) return ctx.info('Too late', 'This round already ended.');
    return lostGame(ctx, gid);
  }
  if (g.uid !== ctx.userId) return notYours(ctx, g.uid);
  if (g.phase !== 'playing') return ctx.info('Too late', 'This round already ended.');
  if (!g.startedAt) return ctx.info('One moment', 'The round is still starting.');
  const m = multX100(Date.now() - g.startedAt);
  return ctx.update(await endGame(engine, g, crashFinish(g, m)));
}

async function replay(ctx, kind) {
  const { engine } = ctx;
  const st = stateOf(engine);
  pruneFinished(st);
  const f = st.finished.get(ctx.argv[0]);
  if (!f || f.kind !== kind || f.sid !== ctx.serverId) {
    return ctx.info('That button expired', kind === 'blackjack' ? 'Start a new hand with **/blackjack 100**.' : 'Start a new round with **/crash 100**.');
  }
  if (f.uid !== ctx.userId) return notYours(ctx, f.uid);
  const tokens = [String(f.bet)];
  if (f.target) tokens.push(`${f.target / 100}x`);
  return startGame(ctx, kind, tokens, 'update');
}

async function againInstant(ctx) {
  const [kind, uid, ...parts] = ctx.argv;
  if (!own(INSTANT_KINDS, kind)) return outOfDate(ctx);
  if (uid !== ctx.userId) return notYours(ctx, uid);
  const p = parseArgs(kind, parts, cfgOf(ctx.engine, ctx.serverId));
  if (p.error || p.amount?.kind !== 'number') return outOfDate(ctx);
  return startGame(ctx, kind, parts, 'update', { forged: true });
}

async function endCommand(ctx, tokens) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const sid = ctx.serverId;
  const who = tokens.join(' ').trim();
  let uid = ctx.userId;
  let byMod = false;
  if (who && !/^(mine|my|me)$/i.test(who)) {
    const found = await ctx.findUser(who);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainWord(who)}**.`);
    if (found.id !== ctx.userId) {
      await ctx.require('mod');
      byMod = true;
    }
    uid = found.id;
  }
  const gid = st.busy.get(busyKey(sid, uid));
  const g = gid && st.games.get(gid);
  if (!g) return ctx.info('No game to end', byMod ? `${mention(uid)} isn't in a live game right now.` : "You're not in a live game right now.");
  if (g.kind === 'crash' && !g.startedAt) return ctx.info('One moment', 'That round is starting right now. Try again in a second.');
  if (g.doubling) return ctx.info('One moment', 'That hand is doubling right now. Try again in a second.');
  if (byMod) {
    const view = await endGame(engine, g, { kind: 'cancel', reason: 'a moderator ended it' });
    editMessage(engine, g.channelId, g.messageId, view);
    return ctx.ok('Game ended', `${mention(uid)}'s game was cancelled and their bet went back.`);
  }
  if (g.kind === 'blackjack') {
    const view = await standHand(engine, g);
    editMessage(engine, g.channelId, g.messageId, view);
    return ctx.ok('Hand stood', `I stood your blackjack hand. ${bjResultText(engine, g)}`);
  }
  const view = await endGame(engine, g, crashFinish(g, multX100(Date.now() - g.startedAt)));
  editMessage(engine, g.channelId, g.messageId, view);
  return ctx.ok('Round ended', `I cashed out your crash round. ${crashResultText(engine, g).split('\n')[0]}`);
}

async function nameOf(engine, sid, uid) {
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return String(m?.nickname || m?.display_name || m?.username || 'them').replace(/[<>@*_`~|]/g, '');
}

function userStats(engine, sid, uid) {
  const u = readDoc(engine, sid).stats[uid];
  return u && typeof u === 'object' && Number(u.n) > 0 ? u : null;
}

async function statsCommand(ctx, tokens) {
  const { engine } = ctx;
  const sid = ctx.serverId;
  const who = tokens.join(' ').trim();
  let uid = ctx.userId;
  if (who) {
    const found = await ctx.findUser(who);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainWord(who)}**.`);
    uid = found.id;
  }
  const mine = uid === ctx.userId;
  const name = mine ? null : await nameOf(engine, sid, uid);
  const title = `📊 ${mine ? 'Your' : `${name}'s`} casino stats`;
  const u = userStats(engine, sid, uid);
  if (!u) return ctx.ephemeral({ embeds: [card({ title, body: mine ? "You haven't played yet. Try **/slots 50**." : `${name} hasn't played yet.`, color: 'casino', footer: false })] });
  const lines = [
    `🎮 Games played: **${fmt(u.n)}**`,
    `💸 Coins bet: ${money(engine, sid, u.wagered)}`,
    `💰 Won back: ${money(engine, sid, u.returned)}`,
    `📈 Net: ${signedMoney(engine, sid, u.returned - u.wagered)}`,
    `🏆 Biggest win: ${Number(u.best) > 0 ? money(engine, sid, u.best) : 'none yet'}`,
  ];
  const per = [];
  for (const [kind, g] of Object.entries(GAMES)) {
    const s = u.games && Object.hasOwn(u.games, kind) ? u.games[kind] : null;
    if (!s || !Number(s.n)) continue;
    per.push(`${g.icon} **${g.name}** · ${plural(Number(s.n), 'game')} · net ${signedMoney(engine, sid, (Number(s.returned) || 0) - (Number(s.wagered) || 0))}`);
  }
  if (per.length) lines.push('', ...per);
  return ctx.ephemeral({ embeds: [card({ title, body: lines.join('\n'), color: 'casino', footer: FUN_NOTE })] });
}

function topView(engine, sid, biggest) {
  const doc = readDoc(engine, sid);
  const list = Object.entries(doc.stats).filter(([, u]) => u && Number(u.n) > 0).map(([uid, u]) => ({ uid, n: Number(u.n) || 0, net: (Number(u.returned) || 0) - (Number(u.wagered) || 0), best: Number(u.best) || 0 }));
  const sorted = biggest ? list.filter((x) => x.best > 0).sort((a, b) => b.best - a.best) : list.sort((a, b) => b.net - a.net);
  const lines = sorted.slice(0, 10).map((x, i) => `${MEDALS[i] || `**${i + 1}.**`} ${mention(x.uid)} · ${biggest ? `biggest win ${money(engine, sid, x.best)}` : `net ${signedMoney(engine, sid, x.net)}`} · ${plural(x.n, 'game')}`);
  const t = doc.totals;
  return {
    embeds: [card({
      title: biggest ? '🏆 Biggest casino wins' : '🏆 Casino leaderboard',
      body: lines.length ? lines.join('\n') : 'Nobody has played here yet.',
      color: 'casino',
      footer: `Server totals: ${plural(Number(t.n) || 0, 'game')} · ${fmt(Number(t.wagered) || 0)} coins bet · ${fmt(Number(t.returned) || 0)} coins paid out`,
    })],
  };
}

function topCommand(ctx, tokens) {
  const biggest = tokens.some((w) => /^(biggest|big|best|wins?|win)$/i.test(String(w)));
  return ctx.reply(topView(ctx.engine, ctx.serverId, biggest));
}

function rulesView(engine, sid) {
  const cfg = cfgOf(engine, sid);
  const lim = limitsOf(cfg);
  const crashMax = crashMaxOf(cfg);
  const off = (k) => (cfg[k] === false ? ' *(off here)*' : '');
  const lines = [
    `🪙 **Coinflip**${off('coinflip')} · pick heads or tails · a win pays **1.95x** · \`/coinflip heads 100\``,
    `🎲 **Dice**${off('dice')} · one six-sided die · a face pays **5.82x**, even, odd, high or low pays **1.94x**, over and under pay more the fewer faces win · \`/dice over 3 100\``,
    `🎰 **Slots**${off('slots')} · three of a kind pays 10x up to **250x** for 7️⃣7️⃣7️⃣, two 🍒 pay **2.5x**, any other pair gives your bet back · \`/slots 100\``,
    `🃏 **Blackjack**${off('blackjack')} · blackjack pays **3:2**, the dealer stands on 17, double on your first two cards · no split, insurance or surrender · \`/blackjack 100\``,
    `🎡 **Roulette**${off('roulette')} · one zero · a number pays **36x**, red, black, even, odd, low or high pays **2x**, dozens and columns pay **3x** · \`/roulette red 100\``,
    `🚀 **Crash**${off('crash')} · the multiplier doubles every 8 seconds, cash out before it crashes · it cashes out by itself at **${crashMax}x** · \`/crash 100 2x\``,
    '',
    `Bets: ${betRangeText(engine, sid, lim)}. Amounts: \`100\`, \`2k\`, \`half\` or \`all\`. Wins include your bet.`,
    'The house keeps a small edge of about 1 to 3 coins per 100 bet, so over time the casino wins. Wins round down to whole coins, so small bets lose a little more.',
    `-# ${FUN_NOTE}`,
  ];
  return { embeds: [card({ title: `${ICONS.casino} Casino rules and payouts`, body: lines.join('\n'), color: 'casino', footer: false })] };
}

function settingsView(engine, sid) {
  const cfg = cfgOf(engine, sid);
  const lim = limitsOf(cfg);
  const cool = inRange('cooldownSeconds', cfg.cooldownSeconds) ?? 0;
  const lines = GAME_KEYS.map((k) => `${GAMES[k].icon} **${GAMES[k].name}:** ${cfg[k] !== false ? '🟢 On' : '⚪ Off'}`);
  lines.push(
    '',
    `📉 **Smallest bet:** ${money(engine, sid, lim.minBet)}`,
    `📈 **Biggest bet:** ${maxBetText(engine, sid, lim.maxBet)}`,
    `⏱️ **Wait between games:** ${cool ? plural(cool, 'second') : 'Off'}`,
    `🚀 **Crash top:** ${crashMaxOf(cfg)}x`,
    '',
    '-# Typed: /casino off slots · /casino maxbet 500 · /casino cooldown 5',
  );
  const toggles = GAME_KEYS.map((k) => button(`${GAMES[k].name}: ${cfg[k] !== false ? 'on' : 'off'}`, cid('toggle', k), cfg[k] !== false ? 'success' : 'secondary'));
  return {
    embeds: [card({ title: '⚙️ Casino settings', body: lines.join('\n'), color: 'casino', footer: false })],
    components: [row(toggles.slice(0, 3)), row(toggles.slice(3)), row(button('Bet limits', cid('limits'), 'primary', '✏️'))],
  };
}

async function panelView(engine, sid, uid, isAdmin) {
  const st = stateOf(engine);
  const cfg = cfgOf(engine, sid);
  const lim = limitsOf(cfg);
  const eco = economyFor(engine, sid);
  const on = GAME_KEYS.filter((k) => cfg[k] !== false);
  const intro = ['Play against the bot with server coins:'];
  if (on.length) for (const k of on) intro.push(`${GAMES[k].icon} **${GAMES[k].name}** · \`${GAMES[k].usage}\``);
  else intro.push('Every game is turned off right now.');
  intro.push('', `Bets: ${betRangeText(engine, sid, lim)} · amounts like \`100\`, \`2k\`, \`half\` or \`all\``);
  if (!eco) intro.push('', '⚠️ The casino needs the **Economy** app. An admin can install it with **/apps**.');
  const u = userStats(engine, sid, uid);
  const live = serverGames(st, sid).length;
  const fields = [
    { name: 'Your casino', value: u ? `${plural(Number(u.n), 'game')} · net ${signedMoney(engine, sid, u.returned - u.wagered)}` : 'No games yet.', inline: true },
    { name: 'Playing now', value: plural(live, 'live game'), inline: true },
  ];
  const gameButtons = on.map((k) => button(GAMES[k].name, cid('play', k), 'primary', GAMES[k].icon));
  const tools = [button('Rules', cid('rules'), 'secondary', '📜'), button('My stats', cid('stats'), 'secondary', '📊'), button('Top', cid('top'), 'secondary', '🏆')];
  if (isAdmin) tools.push(button('Settings', cid('settings'), 'secondary', '⚙️'));
  const components = [];
  if (eco && gameButtons.length) components.push(row(gameButtons.slice(0, 3)));
  if (eco && gameButtons.length > 3) components.push(row(gameButtons.slice(3)));
  components.push(row(tools));
  return { embeds: [card({ title: `${ICONS.casino} Casino`, body: intro.join('\n'), fields, color: 'casino', footer: FUN_NOTE })], components };
}

async function showPanel(ctx) {
  const isAdmin = ctx.engine.perms.atLeast(await ctx.level(), 'admin');
  return ctx.ephemeral(await panelView(ctx.engine, ctx.serverId, ctx.userId, isAdmin));
}

const SETTING_WORDS = { minbet: 'minBet', maxbet: 'maxBet', cooldown: 'cooldownSeconds', crashmax: 'crashMax' };

function savedText(engine, sid, key, n) {
  if (key === 'minBet') return `The smallest bet is now ${money(engine, sid, n)}.`;
  if (key === 'maxBet') return isUnlimited(n) ? 'There is no biggest bet now, so anyone can bet any amount they have.' : `The biggest bet is now ${money(engine, sid, n)}.`;
  if (key === 'cooldownSeconds') return n ? `Players wait ${plural(n, 'second')} between games.` : 'There is no wait between games now.';
  return `Crash rounds cash out by themselves at ${n}x.`;
}

async function adminSetting(ctx, sub, rest) {
  await ctx.require('admin');
  const { engine } = ctx;
  const sid = ctx.serverId;
  if (sub === 'settings' || sub === 'config') return ctx.ephemeral(settingsView(engine, sid));
  if (sub === 'on' || sub === 'off') {
    const on = sub === 'on';
    const word = cleanToken(rest[0]);
    if (word === 'all' || word === 'everything') {
      ctx.patchConfig(Object.fromEntries(GAME_KEYS.map((k) => [k, on])));
      return ctx.ok('Saved', on ? 'Every casino game is on.' : 'Every game is off, so the casino is closed.');
    }
    const kind = own(GAME_ALIASES, word);
    if (!kind) {
      const guess = didYouMean(word, Object.keys(GAME_ALIASES));
      return ctx.warn("I didn't get that", `${word ? `I don't know the game **${plainWord(word)}**.` : 'Which game?'}${guess.length ? ` Did you mean ${[...new Set(guess)].map((g) => `**${g}**`).join(', ')}?` : ''}\nPick coinflip, dice, slots, blackjack, roulette, crash or all, like \`/casino off slots\`.`);
    }
    ctx.patchConfig({ [kind]: on });
    return ctx.ok('Saved', on ? `${gameName(kind)} is on.` : `${gameName(kind)} is off. The other games still work.`);
  }
  const key = own(SETTING_WORDS, sub);
  if (!key) return null;
  const checked = checkSetting(engine, sid, key, rest[0]);
  if (checked.error) return ctx.warn("That didn't work", checked.error);
  ctx.patchConfig({ [key]: checked.value });
  return ctx.ok('Saved', savedText(engine, sid, key, checked.value));
}

async function runCasino(ctx, tokens = ctx.argv) {
  const first = cleanToken(tokens[0]).replace(/^\//, '');
  const rest = tokens.slice(1);
  if (!first || first === 'menu' || first === 'home' || first === 'panel') return showPanel(ctx);
  if (['rules', 'help', 'odds', 'games', 'payouts', 'info'].includes(first)) return ctx.ephemeral(rulesView(ctx.engine, ctx.serverId));
  if (['stats', 'me', 'record'].includes(first)) return statsCommand(ctx, rest);
  if (['top', 'leaderboard', 'lb'].includes(first)) return topCommand(ctx, rest);
  if (['end', 'stop', 'cancel', 'quit'].includes(first)) return endCommand(ctx, rest);
  if (['settings', 'config', 'on', 'off', 'minbet', 'maxbet', 'cooldown', 'crashmax'].includes(first)) return adminSetting(ctx, first, rest);
  const kind = own(GAME_ALIASES, first);
  if (kind) return startGame(ctx, kind, rest);
  const guess = didYouMean(first, [...Object.keys(GAME_ALIASES), ...SUBS]);
  return ctx.warn("I didn't get that", `I don't know **${plainWord(first)}**.${guess.length ? ` Did you mean ${[...new Set(guess)].map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/casino\`, \`/slots 100\` or \`/casino rules\`.`);
}

const PLAY_PICK = {
  coinflip: { label: 'Heads or tails', placeholder: 'heads' },
  dice: { label: 'What to bet on (6, over 3, even)', placeholder: 'over 3' },
  roulette: { label: 'What to bet on (red, 17, 2nd)', placeholder: 'red' },
};

async function playForm(ctx) {
  const kind = ctx.argv[0];
  if (!own(GAMES, kind)) return outOfDate(ctx);
  const lim = limitsOf(cfgOf(ctx.engine, ctx.serverId));
  const fields = [];
  const pick = own(PLAY_PICK, kind);
  if (pick) fields.push({ id: 'pick', label: pick.label, style: 'short', placeholder: pick.placeholder, max: 20 });
  const suggested = withinLimit(lim.minBet * 10, lim.maxBet) ? lim.minBet * 10 : lim.minBet;
  fields.push({ id: 'bet', label: 'Bet (like 100, half or all)', style: 'short', value: String(Number.isSafeInteger(suggested) ? suggested : lim.minBet), max: 20 });
  if (kind === 'crash') fields.push({ id: 'target', label: 'Cash out by itself at (like 2x, optional)', style: 'short', required: false, placeholder: '2x', max: 8 });
  return ctx.form({ title: `Play ${gameName(kind)}`, action: 'playsave', args: [kind], fields });
}

async function playSubmit(ctx) {
  const kind = ctx.argv[0];
  if (!own(GAMES, kind)) return outOfDate(ctx);
  const v = ctx.values || {};
  const tokens = [];
  if (own(PLAY_PICK, kind)) tokens.push(...tokenize(String(v.pick ?? '')));
  tokens.push(...tokenize(String(v.bet ?? '')));
  if (kind === 'crash') {
    const t = String(v.target ?? '').trim().toLowerCase();
    if (t) tokens.push(/x/.test(t) ? t : `${t}x`);
  }
  return startGame(ctx, kind, tokens, 'reply');
}

async function limitsForm(ctx) {
  await ctx.require('admin');
  const cfg = ctx.config();
  const lim = limitsOf(cfg);
  return ctx.form({
    title: 'Casino settings',
    action: 'limitsave',
    fields: [
      { id: 'minbet', label: 'Smallest bet', style: 'short', value: String(lim.minBet), max: 20 },
      { id: 'maxbet', label: 'Biggest bet (inf for no limit)', style: 'short', value: isUnlimited(lim.maxBet) ? 'inf' : String(lim.maxBet), placeholder: 'inf', max: 20 },
      { id: 'cooldown', label: 'Wait between games in seconds (0 = off)', style: 'short', value: String(inRange('cooldownSeconds', cfg.cooldownSeconds) ?? 0), max: 3 },
      { id: 'crashmax', label: 'Crash top multiplier (2 to 100)', style: 'short', value: String(crashMaxOf(cfg)), max: 3 },
    ],
  });
}

async function limitsSave(ctx) {
  await ctx.require('admin');
  const { engine } = ctx;
  const sid = ctx.serverId;
  const v = ctx.values || {};
  const all = { minBet: v.minbet, maxBet: v.maxbet, cooldownSeconds: v.cooldown, crashMax: v.crashmax };
  const labels = { minBet: 'smallest bet', maxBet: 'biggest bet', cooldownSeconds: 'wait', crashMax: 'crash top' };
  const patch = {};
  for (const key of Object.keys(all)) {
    const checked = checkSetting(engine, sid, key, all[key], all);
    if (checked.error) return ctx.warn(`That ${labels[key]} didn't work`, checked.error);
    patch[key] = checked.value;
  }
  ctx.patchConfig(patch);
  return ctx.ok('Saved', `Bets: ${betRangeText(engine, sid, limitsOf(patch))}. Wait between games: ${patch.cooldownSeconds ? plural(patch.cooldownSeconds, 'second') : 'off'}. Crash top: ${patch.crashMax}x.`);
}

async function cleanupJob(job, engine) {
  const st = stateOf(engine);
  const id = job.data?.id || job.key;
  const sid = job.serverId;
  if (!id || !sid) return undefined;
  const g = st.games.get(id);
  if (g) {
    if (engine.settings.isEnabled(sid, ID)) return { reschedule: engine.scheduler.now() + CHECK_MS };
    if (g.doubling || (g.kind === 'crash' && !g.startedAt)) return { reschedule: engine.scheduler.now() + 5_000 };
    const view = await endGame(engine, g, { kind: 'cancel', reason: 'Casino was uninstalled here' });
    await editMessage(engine, g.channelId, g.messageId, view);
    return undefined;
  }
  const rec = readDoc(engine, sid).open[id];
  if (!rec) return undefined;
  if (rec.kind === 'owed') {
    if (Date.now() - (Number(rec.at) || 0) > OWED_GIVE_UP_MS) {
      engine.log.error(`[casino] gave up paying ${rec.held} coins to ${rec.uid} for ${id} after 24 hours`);
      unwatch(engine, sid, id);
      return undefined;
    }
    const res = await settle(engine, sid, id, 'refund', `${gameName(rec.game)} win`);
    if (res && !res.ok) return { reschedule: engine.scheduler.now() + CHECK_MS };
    unwatch(engine, sid, id);
    return undefined;
  }
  const res = await settle(engine, sid, id, 'refund', `${gameName(rec.kind)} bet back`);
  if (res && !res.ok) return { reschedule: engine.scheduler.now() + CHECK_MS };
  unwatch(engine, sid, id);
  if (rec.channelId && rec.messageId) await editMessage(engine, rec.channelId, rec.messageId, lostView());
  return undefined;
}

const numberField = (key, label, help, extra = {}) => {
  const [min, max] = SETTING_RANGES[key];
  return { key, label, type: 'number', web: true, min, max, step: 1, help, ...extra, validate: (ctx, v, all) => checkSetting(ctx.engine, ctx.serverId, key, v, all) };
};

const DASHBOARD = [
  boolField({ key: 'coinflip', label: 'Coinflip', help: 'Heads or tails. A win pays 1.95x.' }),
  boolField({ key: 'dice', label: 'Dice', help: 'Bet on one die: a face, over or under, even or odd.' }),
  boolField({ key: 'slots', label: 'Slots', help: 'Three reels. Three sevens pay 250x.' }),
  boolField({ key: 'blackjack', label: 'Blackjack', help: 'Hit, stand or double against the dealer. Blackjack pays 3:2.' }),
  boolField({ key: 'roulette', label: 'Roulette', help: 'European wheel with one zero: colors, numbers, dozens and columns.' }),
  boolField({ key: 'crash', label: 'Crash', help: 'A rising multiplier. Cash out before it crashes.' }),
  numberField('minBet', 'Smallest bet', 'The fewest coins someone can bet on one game.'),
  numberField('maxBet', 'Biggest bet', 'The most coins someone can bet on one game. Type inf for no limit at all.', { unlimited: true }),
  numberField('cooldownSeconds', 'Wait between games (seconds)', 'How long someone waits before starting another game. 0 turns it off.'),
  numberField('crashMax', 'Crash top multiplier', 'A crash round cashes out by itself when it reaches this.'),
];

const gameCommand = (kind) => (ctx) => startGame(ctx, kind, ctx.argv);

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Casino',
  icon: ICONS.casino,
  description: 'Coinflip, dice, slots, blackjack, roulette and crash for Economy coins.',
  category: 'Fun',
  phase: 3,
  panelPerm: 'member',
  defaultEnabled: false,

  defaults: {
    coinflip: true,
    dice: true,
    slots: true,
    blackjack: true,
    roulette: true,
    crash: true,
    minBet: 10,
    maxBet: 1000,
    cooldownSeconds: 3,
    crashMax: 50,
  },

  dashboard: DASHBOARD,

  commands: {
    casino: { description: 'Casino hub with server coins: /casino, /casino stats, /casino top, /casino rules', run: (ctx) => runCasino(ctx, ctx.argv) },
    coinflip: { description: 'Flip a coin for coins: /coinflip heads 100, /coinflip tails half', run: gameCommand('coinflip') },
    dice: { description: 'Roll a die for coins: /dice 6 100, /dice over 3 100, /dice even 50', run: gameCommand('dice') },
    slots: { description: 'Spin the slot machine: /slots 100', run: gameCommand('slots') },
    blackjack: { description: 'Play blackjack against the dealer: /blackjack 100', run: gameCommand('blackjack') },
    roulette: { description: 'Bet on the roulette wheel: /roulette red 100, /roulette 17 50, /roulette 2nd 100', run: gameCommand('roulette') },
    crash: { description: 'Ride the multiplier and cash out before it crashes: /crash 100, /crash 100 2x', run: gameCommand('crash') },
  },

  components: {
    again: { owner: true, ownerArg: 1, run: againInstant },
    bj: { owner: true, ownerArg: 1, run: bjAction },
    bjagain: { owner: true, ownerArg: 1, run: (ctx) => replay(ctx, 'blackjack') },
    cash: { owner: true, ownerArg: 1, run: cashOut },
    crashagain: { owner: true, ownerArg: 1, run: (ctx) => replay(ctx, 'crash') },
    play: { run: playForm },
    playsave: { run: playSubmit },
    rules: { run: (ctx) => ctx.ephemeral(rulesView(ctx.engine, ctx.serverId)) },
    stats: { run: (ctx) => statsCommand(ctx, []) },
    top: { run: (ctx) => ctx.reply(topView(ctx.engine, ctx.serverId, false)) },
    settings: { perm: 'admin', run: (ctx) => ctx.ephemeral(settingsView(ctx.engine, ctx.serverId)) },
    toggle: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        const kind = ctx.argv[0];
        if (!own(GAMES, kind)) return outOfDate(ctx);
        ctx.patchConfig({ [kind]: ctx.config()[kind] === false });
        return ctx.update(settingsView(ctx.engine, ctx.serverId));
      },
    },
    limits: { perm: 'admin', run: limitsForm },
    limitsave: { perm: 'admin', run: limitsSave },
  },

  jobs: {
    cleanup: cleanupJob,
  },

  onUninstall: (engine, sid) => {
    const s = engine.scheduler;
    if (!s) return;
    for (const job of s.list({ kind: JOB, serverId: sid })) s.schedule({ kind: JOB, at: s.now(), serverId: sid, key: job.key, data: job.data });
  },

  yap: [
    { words: ['casino', 'gamble'], run: (ctx) => runCasino(ctx, ctx.argv) },
    { words: ['coinflip', 'flip', 'cf'], run: gameCommand('coinflip') },
    { words: ['dice', 'roll'], run: gameCommand('dice') },
    { words: ['slots', 'slot', 'spin'], run: gameCommand('slots') },
    { words: ['blackjack', 'bj'], run: gameCommand('blackjack') },
    { words: ['roulette', 'wheel'], run: gameCommand('roulette') },
    { words: ['crash', 'rocket'], run: gameCommand('crash') },
  ],

  panel: showPanel,

  services: (engine) => ({
    isPlaying: (sid, uid) => {
      const st = stateOf(engine);
      const gid = st.busy.get(busyKey(sid, uid));
      return !!gid && st.games.has(gid);
    },
    game: (sid, uid) => {
      const st = stateOf(engine);
      const g = st.games.get(st.busy.get(busyKey(sid, uid)));
      if (!g) return null;
      return { id: g.id, kind: g.kind, phase: g.phase, bet: g.bet, held: g.held, messageId: g.messageId, channelId: g.channelId, startedAt: g.startedAt ?? null, target: g.target ?? null };
    },
    active: (sid) => {
      const list = serverGames(stateOf(engine), sid);
      return { live: list.length, blackjack: list.filter((g) => g.kind === 'blackjack').length, crash: list.filter((g) => g.kind === 'crash').length };
    },
    stats: (sid, uid) => {
      const u = userStats(engine, sid, uid);
      return u ? structuredClone(u) : null;
    },
    totals: (sid) => structuredClone(readDoc(engine, sid).totals),
    sweep: () => sweep(engine),
    useRandom: (fn) => { stateOf(engine).draw = typeof fn === 'function' ? fn : (min, max) => randomInt(min, max); },
  }),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: false, config: {} },
    community: { enabled: false, config: {} },
    roleplay: { enabled: false, config: {} },
  },

  help: [
    'Play casino games against the bot with Economy coins: /coinflip, /dice, /slots, /roulette, /blackjack and /crash. Bets are taken first and wins are paid at once.',
    'Payouts: coinflip 1.95x, dice up to 5.82x, roulette 36x on a number, slots up to 250x, blackjack pays 3:2, crash pays your cash-out multiplier.',
    'Only the player can press a game\'s buttons. One live blackjack or crash game at a time; /casino end stands your hand or cashes out your round, and a mod can end a stuck game with a refund.',
    'Admins: /casino off slots, /casino maxbet 500, /casino minbet 10, /casino cooldown 5, /casino crashmax 50, or the dashboard.',
  ],

  init: (engine) => {
    recoverOrphans(engine).catch((e) => engine.log.error('[casino] start-up check failed:', e));
  },

  dispose: (engine) => {
    const st = states.get(engine);
    if (st) {
      st.disposed = true;
      if (st.timer) clearTimeout(st.timer);
      st.timers.clear();
    }
    states.delete(engine);
  },
});
