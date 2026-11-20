import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, onOff, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, formatDuration, fuzzyFind, fillTemplate, parseDuration, roleId as roleMention } from '../engine/parse.js';
import { permName, friendly } from '../engine/errors.js';
import { accept, reject, boolField } from '../engine/dashboard.js';
import { HARD_CAP, parseLimit, readLimit, isUnlimited } from '../engine/limits.js';
import { GLOBAL_KEY, CURRENCY, globalConfig, patchGlobalConfig, mergeOnce, canGiveCurrency, allowGiver, denyGiver, ownerIds, addSeason, seasonBoard, seasonScore, seasonName, onBoards, hiddenFromBoards, BOARD_HIDDEN_TEXT } from '../engine/global.js';

const ID = 'economy';
const cid = (action, ...args) => customId(ID, action, ...args);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const STREAK_GRACE_MS = 48 * HOUR;
const WORK_COOLDOWN_MS = HOUR;
const BEG_COOLDOWN_MS = 5 * 60_000;
const BEG_MIN = 1;
const BEG_MAX = 25;
const BEG_MISS = 0.3;
const STREAK_STEP = 10;
const STREAK_MAX = 100;
const MAX_BALANCE = HARD_CAP;
const MAX_AMOUNT = HARD_CAP;
const MAX_SETTING = HARD_CAP;
const MAX_USERS = 50000;
const MAX_HISTORY = 20;
const MAX_ITEMS = 20;
const MAX_INVENTORY = 50;
const MAX_STACK = 9999;
const MAX_STOCK = HARD_CAP;
const MAX_SHOP_MESSAGES = 5;
const MAX_REASON = 60;
const MAX_ITEM_NAME = 40;
const PAY_CONFIRM_OVER = 1000;
const TOP_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const CASINO_WIN = /^(?:Coinflip|Dice|Slots|Blackjack|Roulette|Crash|Casino) win$/i;
const SEASON_REASON = /^(?:Trivia win|Daily quest\b.*|YapOS Party\b.*|Chatting|Voice time|Weekly bonus|Level \d+ reward)$/i;
const QUEST_REASON = /^Daily quest\b/i;
const PARTY_KEYS = Object.freeze(['play', 'win', 'tournament', 'prediction']);
export const PARTY_DEFAULTS = Object.freeze({ play: 25, win: 100, tournament: 500, prediction: 50 });
export const PARTY_OLD_DEFAULTS = Object.freeze({ play: 10, win: 25, tournament: 100, prediction: 15 });
export const PARTY_BOUNDS = Object.freeze({ play: 250, win: 1000, tournament: 5000, prediction: 250 });
export const PARTY_PLACE = Object.freeze({ min: 4, second: 50, third: 25 });
export const PARTY_WIN_STREAK = Object.freeze({ step: 10, max: 100 });
const PARTY_LABELS = Object.freeze({ play: 'a game played', win: 'a win', tournament: 'a tournament win', prediction: 'a right prediction' });
export const PARTY_DAILY_PUZZLE = 25;
export const PARTY_DAILY_STREAK = Object.freeze({ step: 5, max: 50 });
const PAY_KEYS = Object.freeze(['chat', 'voice', 'levelup', 'weekly']);
export const PAY_DEFAULTS = Object.freeze({ chat: 3, voice: 1, levelup: 10, weekly: 500 });
const PAY_BOUNDS = Object.freeze({ chat: 50, voice: 20, levelup: 200, weekly: 10000 });
const PAY_LABELS = Object.freeze({ chat: 'chatting, once a minute at most', voice: 'a minute in voice with others', levelup: 'each new level, times the level', weekly: 'the weekly bonus' });
export const CHAT_PAY_COOLDOWN_MS = 60_000;
export const WEEK_MS = 7 * 24 * 3600_000;
export const CLAN_PAY_BONUS = 0.1;
const LEVEL_PAY_STEPS = 50;
const STREAK_DAYS = Object.freeze([7, 30, 100]);
export const STREAK_DEFAULTS = Object.freeze({ 7: 50, 30: 100, 100: 200 });
const STREAK_PCT_MAX = 500;
export const EVENT_DEFAULTS = Object.freeze({ mult: 2, hours: 48, cooldownDays: 30 });
const EVENT_MULT_MAX = 5;
const EVENT_HOURS_MAX = 168;
const EVENT_DAYS_MAX = 365;
const EVENT_KINDS = Object.freeze({ xp: { name: 'XP', icon: '⚡' }, shards: { name: CURRENCY.name, icon: CURRENCY.emoji } });
const BOOSTED_REASON = /^(?:Trivia win|Daily quest\b.*|Chatting|Voice time|Weekly bonus)$/i;
const OWNER_ONLY_EARN = `Only the bot owner can change how many ${CURRENCY.name} people earn.`;
const OWNER_ONLY_MOVE = `Only the bot owner can hand out or take ${CURRENCY.name}.`;

const BEG_YES = [
  'A kind stranger dropped {amount} in your cup.',
  'Someone felt sorry for you and handed over {amount}.',
  'A passing knight tossed you {amount} without slowing down.',
  'A grandma pinched your cheek and gave you {amount}.',
  'You found {amount} in a coat pocket a stranger gave you.',
  'A pigeon dropped {amount} at your feet. Lucky.',
  'A streamer read your sign on air and donated {amount}.',
  'A tourist mistook you for a street performer and paid {amount}.',
];

const BEG_NO = [
  'Everyone walked right past you. Nothing this time.',
  'A cat stared at you, judged you, and left. Nothing.',
  'Someone offered you advice instead of Shards.',
  'You got a high five. Morale up, wallet the same.',
  'A seagull stole the one Shard you were about to get.',
];

const JOBS = [
  'You walked a pack of very excited dogs and earned {amount}.',
  "You fixed the café's wobbly table and earned {amount}.",
  'You delivered pizzas in the rain and earned {amount}.',
  "You sorted the server's lost-and-found box and earned {amount}.",
  'You taught a parrot to say "gg" and earned {amount}.',
  'You tested comfy chairs all afternoon and earned {amount}.',
  'You washed cars at the town fundraiser and earned {amount}.',
  'You built a tiny website for the bakery and earned {amount}.',
  'You won the pub quiz on a technicality and earned {amount}.',
  'You babysat a very polite cat and earned {amount}.',
  'You busked in the town square and earned {amount}.',
  'You watered the neighbor\'s plants (and talked to them) and earned {amount}.',
  'You untangled a box of old cables and earned {amount}.',
  'You streamed for three loyal viewers and earned {amount}.',
  'You proofread a very long fan fiction and earned {amount}.',
];

const STAFF_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_emojis', 'manage_events', 'manage_nicknames', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'mention_everyone', 'view_audit_log'];
const staffPerms = (r) => STAFF_PERMS.filter((k) => r?.perms?.[k] || r?.[k] === true);
const staffList = (r) => staffPerms(r).map((k) => permName(k)).join(', ');
const isEveryone = (r, sid) => /^@?everyone$/i.test(r?.name || '') || r?.id === 'everyone' || r?.id === sid;
const isAuto = (r) => !!r?.auto && r.auto !== 'none';

const busy = new Set();
const warned = new Set();
const payTrackers = new WeakMap();
const PAY_TRACK_MAX = 20000;
let eng = null;

const clock = (engine) => engine.scheduler?.now?.() ?? Date.now();
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString('en-US');
const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine) => globalConfig(engine, ID);
const patchCfg = (ctx, patch) => patchGlobalConfig(ctx.engine, ID, patch);
const readableMentions = (text) => String(text ?? '').replace(/<@&[\w-]+>/g, '@role').replace(/<@!?[\w-]+>/g, '@someone').replace(/<#[\w-]+>/g, '#channel').replace(/<a?:([\w~-]{1,32}):[\w-]+>/g, ':$1:');
const plainName = (name) => readableMentions(name).replace(/[<>*_~`|\\]/g, '').replace(/@/g, '@​').trim() || 'someone';
const nameOfMember = (m) => plainName(m?.nickname || m?.display_name || m?.username || 'someone');
const plural = (n, word) => (Math.abs(n) === 1 && /s$/i.test(word) && word.length > 2 ? word.slice(0, -1) : word);

function currencyOf() {
  return CURRENCY;
}

const money = (cur, n) => `**${fmt(n)}** ${plural(n, cur.name)}`;
const price = (cur, n) => `${fmt(n)} ${cur.emoji}`;

function waitText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function spanText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  if (!d) return waitText(ms);
  const h = Math.floor((mins % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function agoText(ms) {
  if (ms < 60_000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

const AMOUNT_SHAPE = /^\d+(?:\.\d+)?[kmbt]?$/;
const AMOUNT_HELP = `Use a whole number of ${CURRENCY.name}, like \`500\`, \`2k\`, \`5m\` or \`3b\`.`;

export function parseAmount(token) {
  const t = String(token ?? '').trim().toLowerCase().replace(/,/g, '').replace(/^\+/, '');
  if (!AMOUNT_SHAPE.test(t)) return null;
  const n = parseLimit(t, { min: 0, max: MAX_AMOUNT, unlimited: false });
  return n === null ? NaN : n;
}

export function streakBonus(streak) {
  return Math.min(STREAK_MAX, Math.max(0, Math.floor(Number(streak) || 0) * STREAK_STEP));
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

export function partyRates(cfg = {}) {
  const stored = cfg && cfg.partyRates && typeof cfg.partyRates === 'object' ? cfg.partyRates : {};
  const raw = PARTY_KEYS.every((k) => Number(stored[k]) === PARTY_OLD_DEFAULTS[k]) ? {} : stored;
  const out = {};
  for (const k of PARTY_KEYS) out[k] = clampInt(raw[k], 0, PARTY_BOUNDS[k], PARTY_DEFAULTS[k]);
  return out;
}

export function activityPay(cfg = {}) {
  const raw = cfg && cfg.activityPay && typeof cfg.activityPay === 'object' ? cfg.activityPay : {};
  const out = {};
  for (const k of PAY_KEYS) out[k] = clampInt(raw[k], 0, PAY_BOUNDS[k], PAY_DEFAULTS[k]);
  return out;
}

export function levelUpPay(rate, from, to) {
  const r = Math.max(0, Math.floor(Number(rate) || 0));
  const hi = Math.floor(Number(to) || 0);
  const lo = Math.max(Math.floor(Number(from) || 0), hi - LEVEL_PAY_STEPS);
  let sum = 0;
  for (let l = lo + 1; l <= hi; l++) sum += r * l;
  return Math.min(MAX_AMOUNT, sum);
}

export function clanPay(n, inClan, boost = 0) {
  const base = Math.max(0, Math.floor(Number(n) || 0));
  if (!base || !inClan) return base;
  const extra = CLAN_PAY_BONUS + Math.max(0, Math.min(0.5, Number(boost) || 0));
  return Math.max(base + 1, Math.round(base * (1 + extra)));
}

export function streakTable(cfg = {}) {
  const raw = cfg && cfg.streakRewards && typeof cfg.streakRewards === 'object' ? cfg.streakRewards : {};
  const out = {};
  for (const d of STREAK_DAYS) out[d] = clampInt(raw[d], 0, STREAK_PCT_MAX, STREAK_DEFAULTS[d]);
  return out;
}

export function streakMilestone(streak, table = STREAK_DEFAULTS) {
  const s = Math.floor(Number(streak) || 0);
  let day = null;
  if (s >= 100) day = s % 100 === 0 ? 100 : null;
  else if (STREAK_DAYS.includes(s)) day = s;
  if (!day) return null;
  const pct = Math.max(0, Math.floor(Number(table[day]) || 0));
  return pct ? { day, pct } : null;
}

export function nextMilestone(streak) {
  const s = Math.floor(Number(streak) || 0);
  const next = STREAK_DAYS.find((d) => d > s);
  return next || (Math.floor(s / 100) + 1) * 100;
}

export function eventLimits(cfg = {}) {
  const raw = cfg && cfg.eventLimits && typeof cfg.eventLimits === 'object' ? cfg.eventLimits : {};
  const m = Number(raw.mult);
  return {
    mult: raw.mult !== undefined && raw.mult !== null && Number.isFinite(m) ? Math.max(1, Math.min(EVENT_MULT_MAX, Math.round(m * 10) / 10)) : EVENT_DEFAULTS.mult,
    hours: clampInt(raw.hours, 1, EVENT_HOURS_MAX, EVENT_DEFAULTS.hours),
    cooldownDays: clampInt(raw.cooldownDays, 0, EVENT_DAYS_MAX, EVENT_DEFAULTS.cooldownDays),
  };
}

export function boostName(kind, mult) {
  const m = Number(mult) || 1;
  const word = m === 2 ? 'Double' : m === 3 ? 'Triple' : `${m}x`;
  return `${word} ${EVENT_KINDS[kind]?.name || kind}`;
}

const validAmount = (n) => Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT;
const blankDoc = () => ({ users: {}, items: [], seq: 0, shopMsgs: [] });

function fixDoc(d) {
  const doc = d && typeof d === 'object' ? d : blankDoc();
  if (!doc.users || typeof doc.users !== 'object') doc.users = {};
  if (!Array.isArray(doc.items)) doc.items = [];
  if (!Array.isArray(doc.shopMsgs)) doc.shopMsgs = [];
  doc.seq = Number.isInteger(doc.seq) ? doc.seq : 0;
  return doc;
}

const readDoc = (engine, sid) => fixDoc(engine.store.get(ID, sid, null));
const readUsers = (engine) => fixDoc(engine.store.get(ID, GLOBAL_KEY, null));
const mutateUsers = (engine, fn) => mutate(engine, GLOBAL_KEY, fn);

function mutate(engine, sid, fn) {
  let out;
  engine.store.update(ID, sid, (d) => {
    const doc = fixDoc(d);
    out = fn(doc);
    return doc;
  }, blankDoc());
  return out;
}

const blankUser = (start, t) => ({ bal: start, streak: 0, lastDaily: 0, lastWork: 0, inv: {}, hist: [], seen: t });
const invKey = (sid, itemId) => `${sid}:${itemId}`;

function foldUser(into, from, sid) {
  into.bal = Math.max(0, Math.min(MAX_BALANCE, (into.bal || 0) + (Number(from.bal) || 0)));
  if ((Number(from.lastDaily) || 0) > (into.lastDaily || 0)) {
    into.lastDaily = Number(from.lastDaily) || 0;
    into.streak = Math.max(0, Math.floor(Number(from.streak) || 0));
  }
  if ((Number(from.lastWork) || 0) > (into.lastWork || 0)) into.lastWork = Number(from.lastWork) || 0;
  if ((Number(from.lastBeg) || 0) > (into.lastBeg || 0)) into.lastBeg = Number(from.lastBeg) || 0;
  if ((Number(from.lastWeekly) || 0) > (into.lastWeekly || 0)) into.lastWeekly = Number(from.lastWeekly) || 0;
  if (Number.isInteger(from.paidLevel) && from.paidLevel > (Number.isInteger(into.paidLevel) ? into.paidLevel : -1)) into.paidLevel = from.paidLevel;
  into.seen = Math.max(into.seen || 0, Number(from.seen) || 0);
  into.inv = into.inv && typeof into.inv === 'object' ? into.inv : {};
  for (const [key, slot] of Object.entries(from.inv || {})) {
    const n = Math.floor(Number(slot?.n) || 0);
    if (n <= 0) continue;
    const mine = key.includes(':') ? key : invKey(sid, key);
    const have = into.inv[mine] || { name: slot.name || 'Item', n: 0 };
    have.name = have.name || slot.name || 'Item';
    have.n = Math.min(MAX_STACK, (have.n || 0) + n);
    into.inv[mine] = have;
  }
  const hist = [...(Array.isArray(into.hist) ? into.hist : []), ...(Array.isArray(from.hist) ? from.hist : [])]
    .filter((e) => Array.isArray(e) && e.length >= 3)
    .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
  into.hist = hist.slice(-MAX_HISTORY);
}

function migrate(engine) {
  return mergeOnce(engine, ID, {
    blank: blankDoc,
    fold: (into, from, sid) => {
      const doc = fixDoc(into);
      for (const [uid, u] of Object.entries(from?.users || {})) {
        if (!u || typeof u !== 'object') continue;
        if (!doc.users[uid]) {
          while (Object.keys(doc.users).length >= MAX_USERS) evictOne(doc, uid);
          doc.users[uid] = blankUser(0, Number(u.seen) || 0);
        }
        foldUser(doc.users[uid], u, sid);
      }
    },
  });
}

function evictOne(doc, keep) {
  let worst = null;
  for (const [uid, u] of Object.entries(doc.users)) {
    if (uid === keep) continue;
    if (!worst || (u.bal || 0) < (worst.u.bal || 0) || ((u.bal || 0) === (worst.u.bal || 0) && (u.seen || 0) < (worst.u.seen || 0))) worst = { uid, u };
  }
  if (worst) delete doc.users[worst.uid];
}

function ensureUser(doc, uid, cfg, t) {
  let u = doc.users[uid];
  if (u) return u;
  while (Object.keys(doc.users).length >= MAX_USERS) evictOne(doc, uid);
  const start = clampSetting(cfg.startBalance, 0);
  u = blankUser(start, t);
  if (start > 0) u.hist.push([t, start, 'Starting balance']);
  doc.users[uid] = u;
  return u;
}

function clampSetting(v, fallback) {
  return readLimit(v, fallback, { min: 0, max: MAX_SETTING, unlimited: false });
}

function change(u, delta, reason, t) {
  const before = u.bal || 0;
  u.bal = Math.max(0, Math.min(MAX_BALANCE, before + delta));
  const real = u.bal - before;
  u.hist = Array.isArray(u.hist) ? u.hist : [];
  u.seen = t;
  if (!real) return real;
  u.hist.push([t, real, clip(readableMentions(reason || 'Change').replace(/[\r\n]+/g, ' '), MAX_REASON)]);
  if (u.hist.length > MAX_HISTORY) u.hist.splice(0, u.hist.length - MAX_HISTORY);
  return real;
}

function balanceOf(engine, uid) {
  const u = readUsers(engine).users[uid];
  if (u) return u.bal || 0;
  return clampSetting(cfgOf(engine).startBalance, 0);
}

function activeEvent(engine, sid, t = clock(engine)) {
  if (!sid || sid === GLOBAL_KEY) return null;
  const ev = readDoc(engine, sid).event;
  if (!ev || typeof ev !== 'object' || !EVENT_KINDS[ev.kind] || !(Number(ev.endsAt) > t)) return null;
  return ev;
}

function eventMultiplier(engine, sid, kind, t = clock(engine)) {
  const ev = activeEvent(engine, sid, t);
  if (!ev || ev.kind !== kind) return 1;
  const m = Number(ev.mult);
  return Number.isFinite(m) && m > 1 ? Math.min(EVENT_MULT_MAX, m) : 1;
}

function eventBanner(engine, sid, t = clock(engine)) {
  const ev = activeEvent(engine, sid, t);
  if (!ev) return null;
  return `${EVENT_KINDS[ev.kind].icon} **${boostName(ev.kind, ev.mult)}** is on in this server for ${spanText(ev.endsAt - t)} more.`;
}

const boosted = (n, mult) => (mult > 1 ? Math.min(MAX_AMOUNT, Math.round(n * mult)) : n);

function needIds(sid, uid) {
  if (!sid || !uid) throw new TypeError('economy: serverId and userId are required');
}

function needAmount(amount) {
  if (!validAmount(amount)) throw friendly(`Amounts are whole numbers of ${CURRENCY.name}, from 1 up. ${AMOUNT_HELP}`, { title: "That amount didn't work" });
}

export function earnSource(reason) {
  const r = String(reason || '');
  if (r === 'Chatting') return 'chat';
  if (r === 'Voice time') return 'voice';
  if (r === 'Weekly bonus') return 'weekly';
  if (/^Level \d+ reward$/.test(r)) return 'levelup';
  if (CASINO_WIN.test(r)) return 'casino';
  if (QUEST_REASON.test(r)) return 'quest';
  if (/^YapOS Party\b/i.test(r)) return 'party';
  if (/^(?:Game|Trivia) win$/i.test(r)) return 'game';
  return 'other';
}

function earned(engine, uid, amount, source, reason, season) {
  const n = Math.floor(Number(amount) || 0);
  if (!uid || n <= 0) return;
  if (season) {
    try { addSeason(engine, 'shards', uid, n); } catch (e) { engine.log.debug('[economy] season Shards failed', e?.message); }
  }
  Promise.resolve()
    .then(() => engine.bot.emit?.('shards:earned', { user: uid, server_id: null, amount: n, source, reason: reason || null }))
    .catch((e) => engine.log.debug('[economy] shards:earned listener failed', e?.message));
}

function serviceAdd(engine, sid, uid, amount, reason) {
  needIds(sid, uid);
  needAmount(amount);
  if (uid === botId(engine)) return 0;
  const t = clock(engine);
  const cfg = cfgOf(engine);
  let real = 0;
  const source = earnSource(reason);
  const mult = BOOSTED_REASON.test(String(reason || '')) ? eventMultiplier(engine, sid, 'shards', t) : 1;
  const bal = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    real = change(u, boosted(amount, mult), reason || 'Added', t);
    return u.bal;
  });
  earned(engine, uid, real, source, reason, SEASON_REASON.test(String(reason || '')));
  return bal;
}

function serviceTake(engine, sid, uid, amount, reason) {
  needIds(sid, uid);
  needAmount(amount);
  if (uid === botId(engine)) return null;
  if (balanceOf(engine, uid) < amount) return null;
  const t = clock(engine);
  const cfg = cfgOf(engine);
  return mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    if ((u.bal || 0) < amount) return null;
    change(u, -amount, reason || 'Spent', t);
    return u.bal;
  });
}

function serviceTransfer(engine, sid, fromId, toId, amount, reason) {
  needIds(sid, fromId);
  needIds(sid, toId);
  needAmount(amount);
  if (fromId === toId || fromId === botId(engine) || toId === botId(engine)) return false;
  if (balanceOf(engine, fromId) < amount) return false;
  const t = clock(engine);
  const cfg = cfgOf(engine);
  return mutateUsers(engine, (doc) => {
    const from = ensureUser(doc, fromId, cfg, t);
    if ((from.bal || 0) < amount) return false;
    const to = ensureUser(doc, toId, cfg, t);
    if (!doc.users[fromId]) doc.users[fromId] = from;
    change(from, -amount, reason || 'Transfer sent', t);
    change(to, amount, reason || 'Transfer received', t);
    return true;
  });
}

export const OWNER_MODES = Object.freeze(['add', 'remove', 'set']);

function ownerAdjust(engine, uid, mode, amount, reason) {
  if (typeof uid !== 'string' || !uid || uid === botId(engine)) return null;
  if (!OWNER_MODES.includes(mode) || !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_BALANCE) return null;
  const t = clock(engine);
  const cfg = cfgOf(engine);
  const label = clip(String(reason || (mode === 'add' ? 'Owner gift' : 'Owner adjustment')), MAX_REASON);
  return mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    const before = u.bal || 0;
    const delta = mode === 'add' ? amount : mode === 'remove' ? -amount : amount - before;
    const real = change(u, delta, label, t);
    return { before, bal: u.bal || 0, real };
  });
}

function setStreak(engine, uid, n) {
  if (typeof uid !== 'string' || !uid || uid === botId(engine)) return null;
  const streak = Math.floor(Number(n));
  if (!Number.isSafeInteger(streak) || streak < 0) return null;
  const t = clock(engine);
  const cfg = cfgOf(engine);
  return mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    const before = u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS ? Math.max(0, Math.floor(Number(u.streak) || 0)) : 0;
    u.streak = streak;
    if (streak > 0 && !(u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS && t - u.lastDaily >= 0)) u.lastDaily = t - DAY;
    u.seen = t;
    return { before, streak };
  });
}

function ranked(engine) {
  const me = botId(engine);
  return Object.entries(readUsers(engine).users)
    .filter(([uid, u]) => uid !== me && (u.bal || 0) > 0)
    .map(([uid, u]) => ({ id: uid, bal: u.bal || 0 }))
    .sort((a, b) => b.bal - a.bal || a.id.localeCompare(b.id));
}

export function richList(engine) {
  return onBoards(engine, ranked(engine));
}

async function memberOf(engine, sid, uid) {
  return engine.perms.member(sid, uid).catch(() => null);
}

function isBotMember(engine, m, uid) {
  if (uid && uid === botId(engine)) return true;
  if (!m) return false;
  return m.bot === true || m.is_bot === true || m.author_bot === true || (Array.isArray(m.badges) && m.badges.includes('bot'));
}

async function displayName(engine, sid, uid) {
  return nameOfMember(await memberOf(engine, sid, uid));
}

function splitAmount(tokens) {
  const idx = tokens.findIndex((t) => parseAmount(t) !== null && !/^<@/.test(t));
  if (idx < 0) return { amount: null, before: tokens, after: [] };
  return { amount: parseAmount(tokens[idx]), before: tokens.slice(0, idx), after: tokens.slice(idx + 1) };
}

async function findMember(ctx, query, what = 'them') {
  const q = String(query ?? '').trim();
  if (!q) return { problem: ['Who?', `Mention ${what}, like @sam.`] };
  const found = await ctx.findUser(q);
  if (!found?.id) return { problem: ["I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**. Try a mention, like @sam.`] };
  const m = await memberOf(ctx.engine, ctx.serverId, found.id);
  if (!m && found.id !== botId(ctx.engine)) return { problem: ["They aren't here", "That person isn't in this server, so I can't find them here."] };
  return { member: m || found, id: found.id, name: nameOfMember(m || found) };
}

async function modLog(engine, sid, embed, key) {
  try {
    const mod = engine.service('mod');
    if (mod?.log) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (!ch) return;
    engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low', key }).catch((e) => engine.log.debug('[economy] log failed', e?.message));
  } catch (e) {
    engine.log.debug('[economy] log failed', e?.message);
  }
}

function guardReason(engine, sid, roleId) {
  const core = engine.settings.core(sid);
  if ((core.adminRoles || []).includes(roleId)) return 'makes people a YapOS admin here';
  if ((core.modRoles || []).includes(roleId)) return 'makes people a YapOS moderator here';
  const tickets = engine.settings.appConfig(sid, 'tickets') || {};
  if ((tickets.staffRoles || []).includes(roleId)) return 'lets people into every ticket as ticket staff';
  const open = engine.store.get('tickets', sid, null)?.tickets || {};
  if (Object.values(open).some((t) => t && t.roleId === roleId)) return "opens someone's private ticket";
  const automod = engine.settings.appConfig(sid, 'automod') || {};
  if ((automod.exempt?.roles || []).includes(roleId)) return 'is skipped by Automod';
  return null;
}

async function roleProblem(engine, sid, roleId) {
  const all = await engine.perms.roles(sid).catch(() => []);
  const role = all.find((r) => r.id === roleId);
  if (!role) return { reason: "That role doesn't exist anymore." };
  const name = plainName(role.name);
  if (isEveryone(role, sid)) return { role, reason: 'Everyone already has @everyone, so it can\'t be sold.' };
  if (isAuto(role)) return { role, reason: `**@${name}** is given out automatically, so I can't sell it.` };
  if (staffPerms(role).length) return { role, reason: `**@${name}** has staff permissions (${staffList(role)}), so I won't sell it. Use a role without those permissions.` };
  const guard = guardReason(engine, sid, roleId);
  if (guard) return { role, reason: `**@${name}** ${guard}, so I won't sell it.` };
  const can = await engine.perms.canManageRole(sid, roleId).catch(() => ({ ok: false, reason: "I couldn't check that role right now. Try again in a moment." }));
  if (!can.ok) return { role, reason: can.reason };
  return { role, reason: null };
}

async function actorTop(engine, sid, uid) {
  if (engine.isBotOwner(uid)) return Infinity;
  const s = await engine.perms.server(sid).catch(() => null);
  if (s?.owner_id === uid) return Infinity;
  return engine.perms.topPosition(sid, uid);
}

function findItem(items, query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const n = /^#?(\d{1,2})$/.exec(q);
  if (n) return items[Number(n[1]) - 1] || null;
  const rid = roleMention(q);
  if (rid) return items.find((it) => it.roleId === rid) || null;
  const exact = items.find((it) => it.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  return fuzzyFind(q, items, { key: (it) => it.name, maxTypos: 2 })?.item || null;
}

function stockText(it) {
  if (it.stock === null || it.stock === undefined) return '';
  return it.stock > 0 ? ` · ${fmt(it.stock)} left` : ' · sold out';
}

async function shopView(engine, sid, mode = 'select') {
  const doc = readDoc(engine, sid);
  const cur = currencyOf();
  const roles = await engine.perms.roles(sid).catch(() => []);
  const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? `@${plainName(r.name)}` : 'a deleted role'; };
  const items = doc.items.slice(0, MAX_ITEMS);
  const server = await engine.perms.server(sid).catch(() => null);
  const title = `🛒 ${server?.name ? `${plainName(server.name)} shop` : 'Shop'}`;
  if (!items.length) {
    return {
      embeds: [card({ title, body: 'The shop is empty right now.\n-# Admins can stock it: `/shop add role @Supporter 500` or `/shop add item "Golden ticket" 200`.', color: 'economy' })],
      components: [],
    };
  }
  const lines = items.map((it) => `🛒 **${plainName(it.name)}** · ${price(cur, it.price)}${it.roleId ? ` · gives ${roleName(it.roleId)}` : ''}${stockText(it)}`);
  const body = `${lines.join('\n')}\n\n-# Pick something below to buy it. Earn ${cur.name} with /daily and /balance work.`;
  const embeds = [card({ title, body, color: 'economy' })];
  const wallet = row(button('My wallet', cid('wallet'), 'secondary', '👛'));
  const soldOut = (it) => it.stock !== null && it.stock !== undefined && it.stock <= 0;
  if (mode === 'select') {
    const options = items.map((it) => ({
      label: `${it.name} · ${fmt(it.price)}`,
      value: it.id,
      description: soldOut(it) ? 'Sold out' : it.roleId ? `Gives ${roleName(it.roleId)}` : 'Goes to your inventory',
      emoji: '🛒',
    }));
    return { embeds, components: [select(cid('pick'), options, { placeholder: 'Pick something to buy' }), wallet] };
  }
  const itemButtons = items.map((it) => button(`${it.name} · ${fmt(it.price)}`, cid('buy', it.id), soldOut(it) ? 'secondary' : 'primary', '🛒', { disabled: soldOut(it) }));
  return { embeds, components: [...rows(itemButtons).slice(0, 4), wallet] };
}

function trackShop(engine, sid, sent, channelId, mode) {
  const m = sent?.message ?? sent;
  if (!m?.id) return;
  mutate(engine, sid, (doc) => {
    doc.shopMsgs = doc.shopMsgs.filter((x) => x.m !== m.id);
    doc.shopMsgs.push({ c: m.channel_id || channelId, m: m.id, mode });
    if (doc.shopMsgs.length > MAX_SHOP_MESSAGES) doc.shopMsgs.splice(0, doc.shopMsgs.length - MAX_SHOP_MESSAGES);
  });
}

async function refreshShops(engine, sid) {
  const list = readDoc(engine, sid).shopMsgs;
  if (!list.length) return;
  const views = {};
  for (const entry of list) {
    try {
      views[entry.mode] ||= await shopView(engine, sid, entry.mode);
      const v = views[entry.mode];
      engine.budget.edit({ channelId: entry.c, messageId: entry.m, content: '', opts: { embeds: v.embeds, components: v.components } }).catch((e) => {
        if (e?.status === 404 || e?.status === 403) mutate(engine, sid, (doc) => { doc.shopMsgs = doc.shopMsgs.filter((x) => x.m !== entry.m); });
        else engine.log.debug('[economy] shop refresh failed', e?.message);
      });
    } catch (e) {
      engine.log.debug('[economy] shop refresh failed', e?.message);
    }
  }
}

async function postShop(ctx) {
  const { engine, serverId: sid } = ctx;
  if (!readDoc(engine, sid).items.length) return ctx.reply({ ...(await shopView(engine, sid, 'select')), open: true });
  return engine.caps.attempt(sid, 'selects',
    async () => {
      const sent = await ctx.reply({ ...(await shopView(engine, sid, 'select')), open: true });
      trackShop(engine, sid, sent, ctx.channelId, 'select');
      return sent;
    },
    async () => {
      const sent = await ctx.reply({ ...(await shopView(engine, sid, 'buttons')), open: true });
      trackShop(engine, sid, sent, ctx.channelId, 'buttons');
      return sent;
    });
}

async function walletView(ctx, targetId, { self = true } = {}) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const cfg = cfgOf(ctx.engine);
  const doc = readUsers(engine);
  const u = doc.users[targetId] || blankUser(clampSetting(cfg.startBalance, 0), 0);
  const t = clock(engine);
  const list = richList(engine);
  const offBoard = hiddenFromBoards(engine, targetId);
  const pos = offBoard ? -1 : list.findIndex((x) => x.id === targetId);
  const name = await displayName(engine, sid, targetId);
  const alive = u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS ? u.streak || 0 : 0;
  const dailyOn = clampSetting(cfg.dailyAmount, 100) > 0;
  const dailyLeft = u.lastDaily ? u.lastDaily + DAY - t : 0;
  const workLeft = u.lastWork ? u.lastWork + WORK_COOLDOWN_MS - t : 0;
  const inv = Object.values(u.inv || {}).filter((x) => x && x.n > 0);
  const fields = [
    { name: 'Wallet', value: `${fmt(u.bal || 0)} ${plural(u.bal || 0, cur.name)} ${cur.emoji}`, inline: true },
    { name: 'Rank', value: offBoard ? BOARD_HIDDEN_TEXT : pos >= 0 ? `#${pos + 1} of ${fmt(list.length)} everywhere` : 'Not ranked yet', inline: true },
    { name: 'Daily streak', value: alive ? `${alive} day${alive === 1 ? '' : 's'}${alive > 1 ? ' 🔥' : ''}` : 'None yet', inline: true },
    { name: 'Daily', value: !dailyOn ? 'Off' : dailyLeft > 0 ? `in ${waitText(dailyLeft)}` : 'Ready!', inline: true },
    cfg.workEnabled !== false ? { name: 'Work', value: workLeft > 0 ? `in ${waitText(workLeft)}` : 'Ready!', inline: true } : null,
    { name: 'Inventory', value: clip(inv.map((x) => `${fmt(x.n)}× ${plainName(x.name)}`).join(', '), 1024) || 'Empty', inline: false },
  ];
  const body = self ? `One wallet for every server. Earn ${cur.name} with **/daily**, **/daily weekly**, **/balance work**, chatting, voice, level ups and YapOS Party, then spend them in **/shop**. See every way with **/balance earn**.` : null;
  const view = { embeds: [card({ title: `${cur.emoji} ${name}'s wallet`, body, fields, color: 'economy' })], components: [] };
  if (self) {
    const weeklyOn = activityPay(cfg).weekly > 0;
    const weeklyLeft = u.lastWeekly ? u.lastWeekly + WEEK_MS - t : 0;
    if (weeklyOn) fields.splice(4, 0, { name: 'Weekly', value: weeklyLeft > 0 ? `in ${spanText(weeklyLeft)}` : 'Ready!', inline: true });
    const btns = dailyOn ? [button('Daily', cid('daily'), dailyLeft > 0 ? 'secondary' : 'success', '📅')] : [];
    if (weeklyOn) btns.push(button('Weekly', cid('weekly'), weeklyLeft > 0 ? 'secondary' : 'success', '🗓️'));
    if (cfg.workEnabled !== false) btns.push(button('Work', cid('work'), workLeft > 0 ? 'secondary' : 'success', '💼'));
    btns.push(button('Top 10', cid('top'), 'secondary', '🏆'), button('History', cid('history'), 'secondary', '📜'));
    view.components = [row(btns), row([button('Ways to earn', cid('earn'), 'primary', '💡')])];
  }
  return view;
}

async function showWallet(ctx, query, how = 'reply') {
  const q = String(query ?? '').trim();
  if (!q || /^me$/i.test(q)) return ctx[how](await walletView(ctx, ctx.userId, { self: true }));
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**. Try a mention, like \`/balance @sam\`.`);
  if (found.id === ctx.userId) return ctx[how](await walletView(ctx, ctx.userId, { self: true }));
  const m = await memberOf(ctx.engine, ctx.serverId, found.id);
  if (isBotMember(ctx.engine, m, found.id)) return ctx.info('Bots have no wallet', `Bots don't collect ${CURRENCY.name}. Their pockets are full of code.`);
  return ctx[how](await walletView(ctx, found.id, { self: false }));
}

async function claimDaily(ctx) {
  const { engine } = ctx;
  const cfg = cfgOf(ctx.engine);
  const cur = currencyOf();
  const base = clampSetting(cfg.dailyAmount, 100);
  if (base <= 0) return ctx.info('Daily is off', 'The daily reward is switched off right now.');
  const t = clock(engine);
  const mult = eventMultiplier(engine, ctx.serverId, 'shards', t);
  const table = streakTable(cfg);
  const res = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastDaily && t - u.lastDaily < DAY) return { wait: u.lastDaily + DAY - t, streak: u.streak || 0 };
    const kept = u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS;
    const lost = !kept && (u.streak || 0) > 1 ? u.streak : 0;
    u.streak = kept ? (u.streak || 0) + 1 : 1;
    u.lastDaily = t;
    const bonus = streakBonus(u.streak);
    const amount = boosted(Math.round(base * (100 + bonus) / 100), mult);
    const got = change(u, amount, `Daily (day ${u.streak})`, t);
    const milestone = streakMilestone(u.streak, table);
    const reward = milestone ? change(u, boosted(Math.max(1, Math.round(base * milestone.pct / 100)), mult), `Streak reward (day ${u.streak})`, t) : 0;
    return { got: got + reward, reward, milestone, bonus, streak: u.streak, bal: u.bal, lost };
  });
  if (!res.wait) {
    earned(engine, ctx.userId, res.got, 'daily', 'Daily', true);
    Promise.resolve()
      .then(() => engine.bot.emit?.('economy:daily', { user: ctx.userId, server_id: null, streak: res.streak, amount: res.got }))
      .catch((e) => engine.log.debug('[economy] economy:daily listener failed', e?.message));
  }
  if (res.wait) {
    return ctx.warn('Already claimed today', `You get one daily for the whole bot. Your next one is ready in **${waitText(res.wait)}**.${res.streak > 1 ? ` Keep your **${res.streak}-day streak** 🔥 going!` : ''}`);
  }
  const streakText = res.streak > 1 ? `day ${res.streak} streak 🔥` : 'day 1';
  const extra = [];
  if (res.bonus) extra.push(`Streak bonus +${res.bonus}%${res.bonus >= STREAK_MAX ? ' (max)' : ''}.`);
  if (res.lost) extra.push(`Your ${res.lost}-day streak ended, so this is a fresh start.`);
  if (mult > 1) extra.push(`Boosted ×${mult} by this server's event.`);
  const lines = [];
  if (res.reward) lines.push(`🎉 **${res.streak}-day streak reward!** +${fmt(res.reward)} bonus ${plural(res.reward, cur.name)} on top.`);
  lines.push(`Balance **${fmt(res.bal)}** · next daily in ${waitText(DAY)}`);
  const upcoming = nextMilestone(res.streak);
  const upcomingPct = streakMilestone(upcoming, table)?.pct;
  if (!res.reward && upcomingPct && upcoming - res.streak <= 3) extra.push(`Streak reward in ${upcoming - res.streak} day${upcoming - res.streak === 1 ? '' : 's'} (day ${upcoming}).`);
  const banner = eventBanner(engine, ctx.serverId, t);
  if (banner) lines.push(banner);
  extra.push('More ways to earn: **/balance earn**.');
  const body = `${lines.join('\n')}${extra.length ? `\n-# ${extra.join(' ')}` : ''}`;
  return ctx.reply({ embeds: [card({ title: `${cur.emoji} +${fmt(res.got)} ${plural(res.got, cur.name)} (${streakText})`, body, color: 'economy', footer: false })] });
}

async function claimWeekly(ctx) {
  const { engine } = ctx;
  const cfg = cfgOf(engine);
  const cur = currencyOf();
  const base = activityPay(cfg).weekly;
  if (base <= 0) return ctx.info('Weekly bonus is off', 'The weekly bonus is switched off right now. **/daily** still works.');
  const t = clock(engine);
  const mult = eventMultiplier(engine, ctx.serverId, 'shards', t);
  const res = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastWeekly && t - u.lastWeekly < WEEK_MS) return { wait: u.lastWeekly + WEEK_MS - t };
    u.lastWeekly = t;
    const got = change(u, boosted(base, mult), 'Weekly bonus', t);
    return { got, bal: u.bal };
  });
  if (res.wait) return ctx.warn('Already claimed this week', `You get one weekly bonus for the whole bot. The next one is ready in **${spanText(res.wait)}**.`);
  earned(engine, ctx.userId, res.got, 'weekly', 'Weekly bonus', true);
  const boost = mult > 1 ? `\n-# Boosted ×${mult} by this server's event.` : '';
  return ctx.reply({ embeds: [card({ title: `🗓️ +${fmt(res.got)} ${plural(res.got, cur.name)} weekly bonus`, body: `Balance **${fmt(res.bal)}** · next weekly bonus in ${spanText(WEEK_MS)}${boost}`, color: 'economy', footer: false })] });
}

function earnLines(engine) {
  const cfg = cfgOf(engine);
  const cur = currencyOf();
  const pay = activityPay(cfg);
  const party = partyRates(cfg);
  const daily = clampSetting(cfg.dailyAmount, 100);
  const lines = [];
  if (daily > 0) lines.push(`📅 **/daily**: ${price(cur, daily)} a day, up to +${STREAK_MAX}% with a streak, plus streak rewards on day 7, 30 and 100.`);
  if (pay.weekly > 0) lines.push(`🗓️ **/daily weekly**: ${price(cur, pay.weekly)} once every 7 days.`);
  if (cfg.workEnabled !== false) lines.push(`💼 **/balance work**: ${fmt(clampSetting(cfg.workMin, 20))} to ${fmt(clampSetting(cfg.workMax, 80))} ${cur.emoji} once an hour.`);
  if (cfg.begEnabled !== false) lines.push(`🥺 **/beg**: up to ${fmt(BEG_MAX)} ${cur.emoji} every 5 minutes, if someone helps.`);
  if (pay.chat > 0) lines.push(`💬 **Chatting**: ${price(cur, pay.chat)} when your chat earns XP, once a minute at most.`);
  if (pay.voice > 0) lines.push(`🎙️ **Voice**: ${price(cur, pay.voice)} for every minute in voice with someone else.`);
  if (pay.levelup > 0) lines.push(`📈 **Level ups**: ${fmt(pay.levelup)} × your new level, once per level (level 10 pays ${fmt(pay.levelup * 10)} ${cur.emoji}).`);
  lines.push(`🛡️ **Clans**: clan members get +${Math.round(CLAN_PAY_BONUS * 100)}% on chat and voice ${cur.name}, more with a clan boost.`);
  lines.push(`🎉 **YapOS Party**: ${partyText(party)}. The daily puzzle pays ${price(cur, PARTY_DAILY_PUZZLE)} per puzzle and up to ${price(cur, PARTY_DAILY_STREAK.max)} more for a streak.`);
  lines.push('📜 **/quests**: three daily quests, each with its own reward. **/achievements** pay a one-time reward too.');
  lines.push('🎲 **Games and trivia**: win bets in /games and trivia prizes.');
  return lines;
}

function earnView(engine) {
  const body = `${earnLines(engine).join('\n')}\n-# Chat, voice and level-up pay is silent, so it never adds messages to the channel. A server event can boost /daily, weekly, work, chat, voice and quests.`;
  return {
    embeds: [card({ title: `💡 Ways to earn ${CURRENCY.name}`, body: clip(body, 4000), color: 'economy' })],
    components: [row([button('Daily', cid('daily'), 'success', '📅'), button('Weekly', cid('weekly'), 'secondary', '🗓️'), button('Wallet', cid('wallet'), 'secondary', '💰')])],
  };
}

function clanOf(engine, uid) {
  try {
    const c = engine.clans?.getClanOf?.(uid);
    const b = Number(engine.clans?.xpBoost?.(uid)) || 0;
    return { in: !!c, boost: b };
  } catch (e) {
    engine.log.debug('[economy] clan lookup failed', e?.message);
    return { in: false, boost: 0 };
  }
}

function trackersOf(engine) {
  let t = payTrackers.get(engine);
  if (!t) payTrackers.set(engine, (t = { chat: new Map(), voice: new Map() }));
  return t;
}

function trackSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > PAY_TRACK_MAX) map.delete(map.keys().next().value);
}

function payLevel(engine, uid, level, rate) {
  const cfg = cfgOf(engine);
  const t = clock(engine);
  const reason = `Level ${level} reward`;
  const real = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    const paid = Number.isInteger(u.paidLevel) ? u.paidLevel : level - 1;
    if (level <= paid) return 0;
    u.paidLevel = level;
    const amount = levelUpPay(rate, paid, level);
    return amount > 0 ? change(u, amount, reason, t) : 0;
  });
  if (real > 0) earned(engine, uid, real, 'levelup', reason, true);
  return real;
}

async function onXp(ctx, ev) {
  const { engine } = ctx;
  const uid = typeof ev?.user === 'string' ? ev.user : null;
  if (!uid || uid === botId(engine)) return;
  const pay = activityPay(cfgOf(engine));
  const sid = typeof ev.serverId === 'string' && ev.serverId ? ev.serverId : null;
  const on = !!sid && engine.settings.isEnabled(sid, ID);
  const t = clock(engine);
  const { chat: chatPaid, voice: voiceCarry } = trackersOf(engine);
  if (on && pay.chat > 0 && Number(ev.messages) > 0) {
    const last = chatPaid.get(uid);
    if (last === undefined || t - last >= CHAT_PAY_COOLDOWN_MS) {
      trackSet(chatPaid, uid, t);
      const clan = clanOf(engine, uid);
      serviceAdd(engine, sid, uid, clanPay(pay.chat, clan.in, clan.boost), 'Chatting');
    }
  }
  if (on && pay.voice > 0 && Number(ev.voiceSeconds) > 0) {
    const secs = (voiceCarry.get(uid) || 0) + Math.floor(Number(ev.voiceSeconds));
    const mins = Math.floor(secs / 60);
    if (secs % 60) trackSet(voiceCarry, uid, secs % 60);
    else voiceCarry.delete(uid);
    if (mins > 0) {
      const clan = clanOf(engine, uid);
      serviceAdd(engine, sid, uid, Math.min(MAX_AMOUNT, clanPay(mins * pay.voice, clan.in, clan.boost)), 'Voice time');
    }
  }
  const level = Math.floor(Number(ev.level) || 0);
  if (pay.levelup > 0 && ev.leveledUp === true && level > 0) payLevel(engine, uid, level, pay.levelup);
}

async function runDaily(ctx) {
  const tokens = ctx.argv?.length ? ctx.argv : tokenize(ctx.args);
  const sub = String(tokens[0] || '').toLowerCase();
  if (['weekly', 'week'].includes(sub)) return claimWeekly(ctx);
  if (['earn', 'ways', 'how'].includes(sub)) return ctx.reply(earnView(ctx.engine));
  return claimDaily(ctx);
}

async function doBeg(ctx) {
  const { engine } = ctx;
  const cfg = cfgOf(ctx.engine);
  if (cfg.begEnabled === false) return ctx.info('Begging is off', '**/beg** is switched off right now. **/daily** still works.');
  const cur = currencyOf();
  const t = clock(engine);
  const miss = Math.random() < BEG_MISS;
  const pay = miss ? 0 : boosted(BEG_MIN + Math.floor(Math.random() * (BEG_MAX - BEG_MIN + 1)), eventMultiplier(engine, ctx.serverId, 'shards', t));
  const res = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastBeg && t - u.lastBeg < BEG_COOLDOWN_MS) return { wait: u.lastBeg + BEG_COOLDOWN_MS - t };
    u.lastBeg = t;
    const got = pay ? change(u, pay, 'Begging', t) : 0;
    return { got, bal: u.bal };
  });
  if (!res.wait) earned(engine, ctx.userId, res.got, 'beg', 'Begging', true);
  if (res.wait) return ctx.warn('Give it a rest', `People are tired of you asking. Try again in **${waitText(res.wait)}**.`);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const line = res.got ? fillTemplate(pick(BEG_YES), { amount: `${money(cur, res.got)} ${cur.emoji}` }) : pick(BEG_NO);
  return ctx.reply({ embeds: [card({ title: res.got ? '🥺 Someone helped' : '🥺 No luck', body: `${line}\nBalance **${fmt(res.bal)}** · beg again in ${waitText(BEG_COOLDOWN_MS)}`, color: 'economy', footer: false })] });
}

async function doWork(ctx) {
  const { engine } = ctx;
  const cfg = cfgOf(ctx.engine);
  if (cfg.workEnabled === false) return ctx.info('Work is off', '**/balance work** is switched off right now. **/daily** still works.');
  const cur = currencyOf();
  const lo = Math.max(1, clampSetting(cfg.workMin, 20));
  const hi = Math.max(lo, clampSetting(cfg.workMax, 80));
  const t = clock(engine);
  const pay = boosted(lo + Math.floor(Math.random() * (hi - lo + 1)), eventMultiplier(engine, ctx.serverId, 'shards', t));
  const res = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastWork && t - u.lastWork < WORK_COOLDOWN_MS) return { wait: u.lastWork + WORK_COOLDOWN_MS - t };
    u.lastWork = t;
    const got = change(u, pay, 'Work', t);
    return { got, bal: u.bal };
  });
  if (!res.wait) earned(engine, ctx.userId, res.got, 'work', 'Work', true);
  if (res.wait) return ctx.warn('Take a break', `You're worn out. You can work again in **${waitText(res.wait)}**.`);
  const line = fillTemplate(JOBS[Math.floor(Math.random() * JOBS.length)], { amount: `${money(cur, res.got)} ${cur.emoji}` });
  return ctx.reply({ embeds: [card({ title: '💼 Shift done', body: `${line}\nBalance **${fmt(res.bal)}** · work again in ${waitText(WORK_COOLDOWN_MS)}`, color: 'economy', footer: false })] });
}

const BOARD_NAME_TTL_MS = 6 * 60 * 60 * 1000;
const BOARD_NAME_WAIT_MS = 2500;
const BOARD_NAME_CACHE_MAX = 2000;
const boardNameCache = new WeakMap();

async function boardNamer(engine, members, ids) {
  const names = new Map(members.map((m) => [m.id, nameOfMember(m)]));
  if (typeof engine.bot?.user !== 'function') return (id) => names.get(id) || 'a yapper elsewhere';
  let cache = boardNameCache.get(engine);
  if (!cache) boardNameCache.set(engine, (cache = new Map()));
  const t = Date.now();
  const missing = [...new Set(ids)].filter((id) => !names.has(id) && !(cache.get(id) && t - cache.get(id).at < BOARD_NAME_TTL_MS));
  if (missing.length) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), BOARD_NAME_WAIT_MS); timer.unref?.(); });
    const found = await Promise.all(missing.map((id) => Promise.race([Promise.resolve().then(() => engine.bot.user(id)).catch(() => null), late])));
    clearTimeout(timer);
    if (cache.size + missing.length > BOARD_NAME_CACHE_MAX) cache.clear();
    missing.forEach((id, i) => {
      const user = found[i];
      if (user === undefined) return;
      const raw = user && (user.display_name || user.displayName || user.username);
      cache.set(id, { at: t, name: raw ? plainName(raw) : null });
    });
  }
  return (id) => names.get(id) || cache.get(id)?.name || 'a yapper elsewhere';
}

async function topView(ctx) {
  const { engine } = ctx;
  const cur = currencyOf();
  const list = richList(engine);
  const members = await ctx.members().catch(() => []);
  const nameOf = await boardNamer(engine, members, list.slice(0, TOP_SIZE).map((x) => x.id));
  const lines = list.slice(0, TOP_SIZE).map((x, i) => `${MEDALS[i] || `**${i + 1}.**`} ${nameOf(x.id)} · ${price(cur, x.bal)}`);
  const pos = list.findIndex((x) => x.id === ctx.userId);
  const mine = hiddenFromBoards(engine, ctx.userId) ? `You: ${BOARD_HIDDEN_TEXT}` : pos >= 0 ? `You: **#${pos + 1}** of ${fmt(list.length)} · ${price(cur, list[pos].bal)}` : `You aren't ranked yet. Grab your **/daily**!`;
  const body = lines.length ? `${lines.join('\n')}\n\n${mine}\n-# One leaderboard for every server YapOS is in.` : `Nobody has any ${cur.name} yet. Be the first with **/daily**!`;
  return { embeds: [card({ title: `🏆 Richest yappers everywhere`, body, color: 'economy' })], components: [row(button('This season', cid('season'), 'secondary', '🗓️'))] };
}

async function seasonView(ctx) {
  const { engine } = ctx;
  const cur = currencyOf();
  const season = seasonBoard(engine, 'shards');
  const board = { ...season, list: onBoards(engine, season.list) };
  const members = await ctx.members().catch(() => []);
  const nameOf = await boardNamer(engine, members, board.list.slice(0, TOP_SIZE).map((x) => x.id));
  const lines = board.list.slice(0, TOP_SIZE).map((x, i) => `${MEDALS[i] || `**${i + 1}.**`} ${nameOf(x.id)} · ${price(cur, x.score)} earned`);
  const pos = board.list.findIndex((x) => x.id === ctx.userId);
  const mine = hiddenFromBoards(engine, ctx.userId) ? `You: ${BOARD_HIDDEN_TEXT}` : pos >= 0 ? `You: **#${pos + 1}** of ${fmt(board.list.length)} · ${price(cur, board.list[pos].score)} earned` : `You haven't earned any ${cur.name} this month yet. **/daily** is a good start!`;
  const intro = `${cur.name} earned in **${seasonName(board.month)}** from /daily, work, begging, trivia and quests. The top 10 at month end keep a season badge on **/rank**. Nobody's wallet resets.`;
  const body = [intro, '', ...(lines.length ? lines : [`Nobody has earned ${cur.name} this month yet.`]), '', mine].join('\n');
  return { embeds: [card({ title: `🗓️ ${cur.name} season · ${seasonName(board.month)}`, body, color: 'economy' })], components: [row(button('All-time richest', cid('top'), 'secondary', '🏆'))] };
}

async function historyView(ctx, targetId) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const u = readUsers(engine).users[targetId];
  const t = clock(engine);
  const name = await displayName(engine, sid, targetId);
  const list = (u?.hist || []).slice().reverse();
  const lines = list.map(([at, delta, reason]) => `${delta >= 0 ? '➕' : '➖'} ${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))} ${cur.emoji} · ${plainName(reason)} · ${agoText(t - at)}`);
  const body = lines.length ? lines.join('\n') : `No ${cur.name} have moved yet.`;
  const title = lines.length ? `📜 ${name}'s last ${lines.length} change${lines.length === 1 ? '' : 's'}` : `📜 ${name}'s history`;
  return { embeds: [card({ title, body: `${body}\n-# Balance now: ${fmt(u?.bal ?? balanceOf(engine, targetId))} ${cur.emoji} · the last ${MAX_HISTORY} changes are kept.`, color: 'economy' })] };
}

async function showHistory(ctx, query) {
  const q = String(query ?? '').trim();
  if (!q || /^me$/i.test(q)) return ctx.ephemeral(await historyView(ctx, ctx.userId));
  const lvl = await ctx.level();
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**.`);
  if (found.id !== ctx.userId && !ctx.engine.perms.atLeast(lvl, 'admin')) {
    return ctx.ephemeral({ embeds: [dialog.denied('admin', { body: "Only admins can see someone else's history. You can see your own with `/balance history`." })] });
  }
  return ctx.ephemeral(await historyView(ctx, found.id));
}

async function startPay(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const { amount, before, after } = splitAmount(tokens);
  const who = [...before, ...after].join(' ').trim();
  if (amount === null || !who) return ctx.warn('Pay who, and how much?', 'Try `/balance pay @sam 50`.');
  if (!validAmount(amount)) return ctx.warn("That amount didn't work", `Pay a whole number of ${cur.name}, from 1 up, like \`/balance pay @sam 50\`.`);
  const target = await findMember(ctx, who, 'who to pay');
  if (target.problem) return ctx.warn(...target.problem);
  if (target.id === ctx.userId) return ctx.warn("You can't pay yourself", `Nice try! Those ${cur.name} are already yours.`);
  if (isBotMember(engine, target.member, target.id)) return ctx.warn(`Bots can't take ${cur.name}`, 'Pay a person instead.');
  const have = balanceOf(engine, ctx.userId);
  if (have < amount) return ctx.warn(`Not enough ${cur.name}`, `You have ${price(cur, have)} and tried to pay ${price(cur, amount)}.`);
  if (amount > PAY_CONFIRM_OVER) {
    const s = engine.router.session({ sid, from: ctx.userId, to: target.id, amount, name: target.name });
    return ctx.ephemeral({
      embeds: [dialog.warn('Big payment', `Send ${money(cur, amount)} ${cur.emoji} to **${target.name}**?\nYou'll have ${price(cur, have - amount)} left. Payments can't be taken back.`)],
      components: [row(button(`Send ${fmt(amount)}`, cid('payok', s, ctx.userId), 'success', '💸'), button('Cancel', cid('payno', s, ctx.userId), 'secondary'))],
    });
  }
  return finishPay(ctx, { from: ctx.userId, to: target.id, amount, name: target.name }, 'reply');
}

async function finishPay(ctx, p, how) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const fromName = await displayName(engine, sid, p.from);
  const ok = mutatePay(engine, p, fromName);
  if (!ok) {
    const have = balanceOf(engine, p.from);
    const embed = dialog.warn(`Not enough ${cur.name}`, `You have ${price(cur, have)} now, so ${price(cur, p.amount)} didn't go through.`);
    return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] });
  }
  const after = balanceOf(engine, p.from);
  const embed = card({ title: `💸 ${fromName} paid ${p.name}`, body: `${money(cur, p.amount)} ${cur.emoji} sent. ${fromName} has ${price(cur, after)} left.`, color: 'economy', footer: false });
  return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

function mutatePay(engine, p, fromName) {
  const t = clock(engine);
  const cfg = cfgOf(engine);
  return mutateUsers(engine, (doc) => {
    const from = ensureUser(doc, p.from, cfg, t);
    if ((from.bal || 0) < p.amount) return false;
    const to = ensureUser(doc, p.to, cfg, t);
    if (!doc.users[p.from]) doc.users[p.from] = from;
    change(from, -p.amount, `Paid ${p.name}`, t);
    change(to, p.amount, `From ${fromName}`, t);
    return true;
  });
}

async function runBalance(ctx, tokensIn) {
  const tokens = tokensIn ?? (ctx.argv.length ? ctx.argv : tokenize(ctx.args));
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (['pay', 'give', 'send', 'transfer'].includes(sub)) return startPay(ctx, rest);
  if (['work', 'job', 'shift'].includes(sub)) return doWork(ctx);
  if (['beg', 'plead'].includes(sub)) return doBeg(ctx);
  if (['top', 'leaderboard', 'lb', 'rich', 'richest'].includes(sub)) return ctx.reply(await topView(ctx));
  if (['season', 'seasons', 'month', 'monthly'].includes(sub)) return ctx.reply(await seasonView(ctx));
  if (['history', 'log', 'hist'].includes(sub)) return showHistory(ctx, rest.join(' '));
  if (sub === 'daily') return claimDaily(ctx);
  if (['weekly', 'week'].includes(sub)) return claimWeekly(ctx);
  if (['earn', 'earning', 'ways', 'income', 'how'].includes(sub)) return ctx.reply(earnView(ctx.engine));
  return showWallet(ctx, tokens.join(' '));
}

async function openBuy(ctx, itemId) {
  const { engine, serverId: sid } = ctx;
  const doc = readDoc(engine, sid);
  const cur = currencyOf();
  const item = doc.items.find((it) => it.id === itemId);
  if (!item) return ctx.warn('That item is gone', 'It was taken out of the shop. Run **/shop** for the current list.');
  if (item.stock !== null && item.stock !== undefined && item.stock <= 0) return ctx.warn('Sold out', `**${plainName(item.name)}** is sold out. An admin can restock it with \`/shop stock\`.`);
  let roleLine = 'It goes into your inventory (see **/balance**).';
  if (item.roleId) {
    const me = await memberOf(engine, sid, ctx.userId);
    if (me?.roles?.includes(item.roleId)) return ctx.info('You already have it', `You already have the role from **${plainName(item.name)}**, so there's nothing to buy.`);
    const check = await roleProblem(engine, sid, item.roleId);
    if (check.reason) return pausedItem(ctx, item, check.reason, 'ephemeral');
    roleLine = `You get the **@${plainName(check.role.name)}** role.`;
  } else {
    const inv = readUsers(engine).users[ctx.userId]?.inv || {};
    if (!inv[invKey(sid, item.id)] && Object.keys(inv).length >= MAX_INVENTORY) return ctx.warn('Inventory full', `You can hold ${MAX_INVENTORY} different items. Ask an admin to clear some out.`);
  }
  const have = balanceOf(engine, ctx.userId);
  if (have < item.price) return ctx.warn(`Not enough ${cur.name}`, `**${plainName(item.name)}** costs ${price(cur, item.price)} and you have ${price(cur, have)}. You need ${price(cur, item.price - have)} more.\n-# Earn ${cur.name} with /daily and /balance work.`);
  const ticket = buyTicket(engine, sid, ctx.userId, item);
  return ctx.ephemeral({
    embeds: [card({ title: `🛒 Buy ${plainName(item.name)}?`, body: `Price **${price(cur, item.price)}** · you have ${price(cur, have)}, so ${price(cur, have - item.price)} after.\n${roleLine}`, color: 'economy', footer: false })],
    components: [row(button(`Buy for ${fmt(item.price)}`, cid('buyok', ticket, ctx.userId), 'success', '🛒'), button('Cancel', cid('buyno', ticket, ctx.userId), 'secondary'))],
  });
}

async function pausedItem(ctx, item, reason, how) {
  const { engine, serverId: sid } = ctx;
  const key = `${sid}:${item.id}:${reason}`;
  if (!warned.has(key)) {
    if (warned.size > 2000) warned.clear();
    warned.add(key);
    await modLog(engine, sid, card({ title: `${ICONS.economy} Shop item paused`, body: `Someone tried to buy **${plainName(item.name)}**, but I can't hand out its role: ${reason}\nFix the role, or take the item out with \`/shop remove\`.`, color: 'economy' }), `economy:paused:${item.id}`);
  }
  const embed = dialog.warn("Can't sell this right now", `**${plainName(item.name)}** is paused: ${reason}\nNo ${currencyOf().name} were taken. I've let the admins know.`);
  return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] });
}

function buyTicket(engine, sid, uid, item) {
  return engine.router.session({ kind: 'buy', sid, uid, itemId: item.id, price: item.price });
}

async function completeBuy(ctx) {
  const { engine, serverId: sid } = ctx;
  const ticket = engine.router.getSession(ctx.argv[0]);
  if (!ticket || ticket.kind !== 'buy' || ticket.sid !== sid || ticket.uid !== ctx.userId) {
    return ctx.update({ embeds: [dialog.info('Already handled', 'This purchase was already made, canceled or expired, so nothing more was taken.\n-# Pick the item again in **/shop** to buy another.')], components: [] });
  }
  engine.router.dropSession(ctx.argv[0]);
  const { itemId, price: priceArg } = ticket;
  const lock = `${sid}:${ctx.userId}`;
  if (busy.has(lock)) return ctx.info('One moment', "I'm still finishing your last purchase.");
  busy.add(lock);
  try {
    return await buyNow(ctx, itemId, Number(priceArg));
  } finally {
    busy.delete(lock);
  }
}

async function buyNow(ctx, itemId, agreed) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const cfg = cfgOf(ctx.engine);
  const done = (embed) => ctx.update({ embeds: [embed], components: [] });
  const item = readDoc(engine, sid).items.find((it) => it.id === itemId);
  if (!item) return done(dialog.warn('That item is gone', 'It was taken out of the shop, so nothing was bought.'));
  if (item.price !== agreed) return done(dialog.warn('The price changed', `**${plainName(item.name)}** now costs ${price(cur, item.price)}. Pick it again in **/shop** if you still want it.`));
  let roleName = null;
  if (item.roleId) {
    const me = await memberOf(engine, sid, ctx.userId);
    if (me?.roles?.includes(item.roleId)) return done(dialog.info('You already have it', 'Nothing was taken.'));
    const check = await roleProblem(engine, sid, item.roleId);
    if (check.reason) return pausedItem(ctx, item, check.reason, 'update');
    roleName = plainName(check.role.name);
  }
  const t = clock(engine);
  const claim = mutate(engine, sid, (doc) => {
    const it = doc.items.find((x) => x.id === itemId);
    if (!it || it.price !== agreed) return { gone: true };
    if (it.stock !== null && it.stock !== undefined && it.stock <= 0) return { soldOut: true };
    if (it.stock !== null && it.stock !== undefined) it.stock -= 1;
    it.sold = (it.sold || 0) + 1;
    return { ok: true, name: it.name, cost: it.price, roleId: it.roleId, limited: it.stock !== null && it.stock !== undefined };
  });
  if (claim.gone) return done(dialog.warn('That item changed', 'Nothing was bought. Run **/shop** for the current list.'));
  if (claim.soldOut) return done(dialog.warn('Sold out', `Someone got the last **${plainName(item.name)}** first. Nothing was taken.`));
  const res = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if ((u.bal || 0) < claim.cost) return { short: u.bal || 0 };
    u.inv ||= {};
    const key = invKey(sid, itemId);
    if (!claim.roleId && !u.inv[key] && Object.keys(u.inv).length >= MAX_INVENTORY) return { full: true };
    change(u, -claim.cost, `Bought ${claim.name}`, t);
    if (!claim.roleId) {
      const slot = u.inv[key] || { name: claim.name, n: 0 };
      slot.name = claim.name;
      slot.n = Math.min(MAX_STACK, slot.n + 1);
      u.inv[key] = slot;
    }
    return { ok: true, bal: u.bal };
  });
  if (!res.ok) {
    releaseItem(engine, sid, itemId, claim.limited);
    if (claim.limited) refreshShops(engine, sid).catch(() => {});
    if (res.full) return done(dialog.warn('Inventory full', `You can hold ${MAX_INVENTORY} different items. Nothing was taken.`));
    return done(dialog.warn(`Not enough ${cur.name}`, `You have ${price(cur, res.short)} and it costs ${price(cur, claim.cost)}. Nothing was taken.`));
  }
  if (item.roleId) {
    try {
      await engine.bot.addRole(sid, ctx.userId, item.roleId);
      engine.perms.invalidate(`m:${sid}:${ctx.userId}`);
    } catch (e) {
      refund(engine, sid, ctx.userId, itemId, claim);
      if (claim.limited) refreshShops(engine, sid).catch(() => {});
      const why = e?.status === 403 ? `My role must be above **@${roleName}** and have Manage Roles.` : "Yapin' didn't let me give the role just now.";
      return done(dialog.error("Couldn't give the role", `${why} Your ${price(cur, claim.cost)} went back to your wallet.`));
    }
  }
  if (claim.limited) refreshShops(engine, sid).catch(() => {});
  const got = item.roleId ? `You now have the **@${roleName}** role. Enjoy!` : `It's in your inventory. See it with **/balance**.`;
  return done(dialog.ok(`Bought ${plainName(item.name)}`, `${got}
Paid ${price(cur, claim.cost)} · balance ${price(cur, res.bal)}`, { footer: false }));
}

function releaseItem(engine, sid, itemId, limited) {
  mutate(engine, sid, (doc) => {
    const it = doc.items.find((x) => x.id === itemId);
    if (!it) return;
    if (limited && it.stock !== null && it.stock !== undefined) it.stock += 1;
    it.sold = Math.max(0, (it.sold || 0) - 1);
  });
}

function refund(engine, sid, uid, itemId, claim) {
  const t = clock(engine);
  const cfg = cfgOf(engine);
  mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    change(u, claim.cost, `Refund: ${claim.name}`, t);
  });
  releaseItem(engine, sid, itemId, claim.limited);
}

const SHOP_SUBS = ['add', 'remove', 'stock', 'price', 'buy', 'list'];

async function runShop(ctx) {
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || sub === 'list' || sub === 'show') return postShop(ctx);
  if (sub === 'buy') {
    const item = findItem(readDoc(ctx.engine, ctx.serverId).items, rest.join(' '));
    if (!item) return ctx.warn("I couldn't find that item", 'Run **/shop** to see what is for sale.');
    return openBuy(ctx, item.id);
  }
  if (['add', 'new', 'create'].includes(sub)) { await ctx.require('admin'); return shopAdd(ctx, rest); }
  if (['remove', 'delete', 'del', 'rm'].includes(sub)) { await ctx.require('admin'); return shopRemove(ctx, rest); }
  if (['stock', 'restock', 'limit'].includes(sub)) { await ctx.require('admin'); return shopStock(ctx, rest); }
  if (['price', 'cost'].includes(sub)) { await ctx.require('admin'); return shopPrice(ctx, rest); }
  const item = findItem(readDoc(ctx.engine, ctx.serverId).items, tokens.join(' '));
  if (item) return openBuy(ctx, item.id);
  const guess = didYouMean(sub, SHOP_SUBS);
  return ctx.warn("I didn't get that", `I don't know **${plainName(clip(sub, 30))}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/shop\` on its own to see the shop.`);
}

async function shopAdd(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  let kind = (tokens[0] || '').toLowerCase();
  let rest = tokens.slice(1);
  if (kind !== 'role' && kind !== 'item') {
    if (tokens[0] && roleMention(tokens[0])) { kind = 'role'; rest = tokens; } else {
      return ctx.warn('A role or an item?', 'Try `/shop add role @Supporter 500` (sells a role) or `/shop add item "Golden ticket" 200` (goes to the inventory).');
    }
  }
  const last = rest[rest.length - 1];
  const cost = parseAmount(last);
  const what = rest.slice(0, -1).join(' ').trim();
  if (cost === null || !what) return ctx.warn('Name and price, please', kind === 'role' ? 'Try `/shop add role @Supporter 500`.' : 'Try `/shop add item "Golden ticket" 200`.');
  if (!validAmount(cost)) return ctx.warn("That price didn't work", `Prices start at 1. ${AMOUNT_HELP}`);
  const items = readDoc(engine, sid).items;
  if (kind === 'role') {
    const role = await ctx.findRole(what);
    if (!role) return ctx.warn("I couldn't find that role", `Nothing here matches **${plainName(clip(what, 40))}**. Try a mention, like @Supporter.`);
    const check = await roleProblem(engine, sid, role.id);
    if (check.reason) return ctx.warn("I can't sell that role", check.reason);
    const top = await actorTop(engine, sid, ctx.userId);
    if (typeof role.position === 'number' && role.position >= top) return ctx.warn("I can't sell that role", `**@${plainName(role.name)}** is at or above your highest role, so you can't sell it.`);
    const existing = items.find((it) => it.roleId === role.id);
    if (existing) {
      mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === existing.id); if (it) it.price = cost; });
      refreshShops(engine, sid).catch(() => {});
      return ctx.ok('Price updated', `**@${plainName(role.name)}** was already in the shop. It now costs ${price(cur, cost)}.`);
    }
    if (items.length >= MAX_ITEMS) return ctx.warn('The shop is full', `It holds ${MAX_ITEMS} items. Take one out with \`/shop remove\` first.`);
    const item = addItem(engine, sid, { name: clip(plainName(role.name), MAX_ITEM_NAME), roleId: role.id, price: cost });
    refreshShops(engine, sid).catch(() => {});
    return ctx.ok('Added to the shop', `🛒 **${plainName(item.name)}** · ${price(cur, cost)} · gives @${plainName(role.name)}\n-# Limit how many sell with \`/shop stock "${item.name}" 10\`.`);
  }
  const name = clip(readableMentions(what).replace(/[\r\n]+/g, ' ').replace(/[<>*_~`|\\@]/g, '').replace(/\s+/g, ' ').trim(), MAX_ITEM_NAME);
  if (!name) return ctx.warn("That name didn't work", 'Give the item a plain name, like "Golden ticket".');
  const existing = items.find((it) => !it.roleId && it.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === existing.id); if (it) it.price = cost; });
    refreshShops(engine, sid).catch(() => {});
    return ctx.ok('Price updated', `**${name}** was already in the shop. It now costs ${price(cur, cost)}.`);
  }
  if (items.length >= MAX_ITEMS) return ctx.warn('The shop is full', `It holds ${MAX_ITEMS} items. Take one out with \`/shop remove\` first.`);
  addItem(engine, sid, { name, roleId: null, price: cost });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Added to the shop', `🛒 **${name}** · ${price(cur, cost)} · goes to the buyer's inventory\n-# Limit how many sell with \`/shop stock "${name}" 10\`.`);
}

function addItem(engine, sid, { name, roleId, price: cost }) {
  return mutate(engine, sid, (doc) => {
    doc.seq += 1;
    const item = { id: `i${doc.seq.toString(36)}`, name, roleId, price: cost, stock: null, sold: 0 };
    doc.items.push(item);
    return item;
  });
}

function itemList(items) {
  return items.map((it, i) => `**${i + 1}.** ${plainName(it.name)}`).join('\n');
}

async function shopRemove(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const items = readDoc(engine, sid).items;
  if (!items.length) return ctx.info('The shop is empty', 'There is nothing to take out.');
  const q = tokens.join(' ');
  const item = q ? findItem(items, q) : null;
  if (!item) return ctx.warn(q ? "I couldn't find that item" : 'Remove which item?', `Use its name or number, like \`/shop remove 2\`.\n${itemList(items)}`);
  let saved = null;
  mutate(engine, sid, (doc) => {
    const idx = doc.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) saved = { idx, item: doc.items.splice(idx, 1)[0] };
  });
  refreshShops(engine, sid).catch(() => {});
  if (!saved) return ctx.info('Already gone', 'That item was already out of the shop.');
  const undo = adminUndo(ctx, `remove ${clip(item.name, 30)}`, async () => {
    mutate(engine, sid, (doc) => {
      if (doc.items.some((x) => x.id === saved.item.id) || doc.items.length >= MAX_ITEMS) return;
      doc.items.splice(Math.min(saved.idx, doc.items.length), 0, saved.item);
    });
    refreshShops(engine, sid).catch(() => {});
  });
  return ctx.ok('Taken out of the shop', `**${plainName(item.name)}** is gone from the shop. People who bought it keep it.`, { components: [row(undo.button)] });
}

async function shopStock(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const items = readDoc(engine, sid).items;
  if (!items.length) return ctx.info('The shop is empty', 'Add something first with `/shop add`.');
  const last = (tokens[tokens.length - 1] || '').toLowerCase();
  const unlimited = ['off', 'clear'].includes(last) || isUnlimited(last);
  const n = unlimited ? null : parseAmount(last);
  if (!unlimited && (n === null || Number.isNaN(n))) return ctx.warn('How many?', 'Try `/shop stock "Golden ticket" 10`, or `/shop stock "Golden ticket" inf` for no limit.');
  if (!unlimited && (n < 0 || n > MAX_STOCK)) return ctx.warn("That stock didn't work", 'Use a whole number from 0 up, like `10` or `5k`, or `inf` for no limit.');
  const q = tokens.slice(0, -1).join(' ');
  const item = q ? findItem(items, q) : items.length === 1 ? items[0] : null;
  if (!item) return ctx.warn(q ? "I couldn't find that item" : 'Which item?', `Name it, like \`/shop stock 2 ${unlimited ? 'off' : n}\`.\n${itemList(items)}`);
  mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === item.id); if (it) it.stock = unlimited ? null : n; });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Stock saved', unlimited ? `**${plainName(item.name)}** has no limit now.` : `**${plainName(item.name)}**: ${fmt(n)} left${n === 0 ? ' (sold out)' : ''}.`);
}

async function shopPrice(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf();
  const items = readDoc(engine, sid).items;
  const cost = parseAmount(tokens[tokens.length - 1]);
  const item = findItem(items, tokens.slice(0, -1).join(' ')) || (items.length === 1 && tokens.length === 1 ? items[0] : null);
  if (!item || cost === null) return ctx.warn('Which item, and what price?', `Try \`/shop price 2 750\`.${items.length ? `\n${itemList(items)}` : ''}`);
  if (!validAmount(cost)) return ctx.warn("That price didn't work", `Prices start at 1. ${AMOUNT_HELP}`);
  mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === item.id); if (it) it.price = cost; });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Price saved', `**${plainName(item.name)}** now costs ${price(cur, cost)}.`);
}

function adminUndo(ctx, label, revert, { giver = false } = {}) {
  const { engine, serverId: sid } = ctx;
  return engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label, perm: 'admin',
    run: async (i) => {
      if (i?.server_id && i.server_id !== sid) throw friendly('That Undo button belongs to another server, so it does nothing here.', { title: 'Wrong server' });
      if (i?.user_id) await engine.perms.require(sid, i.user_id, 'admin');
      if (giver && !canGiveCurrency(engine, i?.user_id || ctx.userId)) throw friendly(OWNER_ONLY_MOVE, { title: 'Owner only' });
      return revert();
    },
  });
}

async function settingsView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(ctx.engine);
  const cur = currencyOf();
  const list = ranked(engine);
  const total = list.reduce((a, x) => Math.min(Number.MAX_SAFE_INTEGER, a + x.bal), 0);
  const items = readDoc(engine, sid).items;
  const work = cfg.workEnabled !== false;
  const fields = [
    { name: 'Currency', value: `${cur.emoji} ${cur.name} · the same everywhere`, inline: true },
    { name: 'Daily', value: clampSetting(cfg.dailyAmount, 100) > 0 ? `${price(cur, clampSetting(cfg.dailyAmount, 100))} · streak bonus up to +${STREAK_MAX}%` : 'Off', inline: true },
    { name: 'Work', value: `${onOff(work)} · ${fmt(clampSetting(cfg.workMin, 20))} to ${fmt(clampSetting(cfg.workMax, 80))} ${cur.emoji}, once an hour`, inline: false },
    { name: 'Starting balance', value: price(cur, clampSetting(cfg.startBalance, 0)), inline: true },
    { name: 'Shop', value: `${items.length}/${MAX_ITEMS} items here`, inline: true },
    { name: `People with ${cur.name}`, value: `${fmt(list.length)} · ${price(cur, total)} in total`, inline: true },
    { name: 'YapOS Party', value: partyText(partyRates(cfg)), inline: false },
    { name: 'Activity pay', value: payText(activityPay(cfg)), inline: false },
    { name: 'Streak rewards', value: streakText(streakTable(cfg)), inline: false },
    { name: 'Server events', value: limitsText(eventLimits(cfg)), inline: false },
  ];
  const body = `Wallets are shared across every server. Earn rates are set once for the whole bot, so only the bot owner can change them. Your shop stays yours.
Typed settings: \`/economy give @sam 100\` · \`/economy take @sam 50\` · \`/economy reset @sam\` · \`/economy daily 150\` · \`/economy work 20 80\` · \`/economy allow @sam\` · \`/economy party 25 100 500 50\` · \`/economy earn 3 1 10 500\` · \`/economy streak 50 100 200\` · \`/economy events 2 48 30\``;
  const rate = [
    button('Daily amount', cid('dailyform'), 'secondary', '📅'),
    button(work ? 'Work: on' : 'Work: off', cid('twork'), work ? 'success' : 'secondary', '💼'),
    button('Work pay', cid('workform'), 'secondary', '💰'),
    button('Starting balance', cid('startform'), 'secondary', '🎒'),
  ];
  const move = [
    button(`Give ${cur.name}`, cid('giveform'), 'primary', '➕'),
    button(`Take ${cur.name}`, cid('takeform'), 'secondary', '➖'),
    button('Reset someone', cid('resetform'), 'danger', '🧽'),
  ];
  const more = [
    button('Party pay', cid('partyform'), 'secondary', '🎉'),
    button('Activity pay', cid('payform'), 'secondary', '💬'),
    button('Streak rewards', cid('streakform'), 'secondary', '🔥'),
    button('Event limits', cid('evlimitform'), 'secondary', '🎪'),
  ];
  return {
    embeds: [card({ title: `${ICONS.economy} Economy settings`, body, fields, color: 'economy' })],
    components: canGiveCurrency(engine, ctx.userId) ? [row(rate), row(more), row(move)] : [],
  };
}

const ownsPanel = (ctx) => {
  const messageId = ctx.source?.message_id;
  return !!messageId && ctx.engine.router.panelOwner(messageId) === ctx.userId;
};

async function showSettings(ctx) {
  await ctx.require('admin');
  return ctx.ephemeral(await settingsView(ctx));
}

async function needGiver(ctx, why) {
  if (canGiveCurrency(ctx.engine, ctx.userId)) return true;
  await ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Owner only', body: why })] });
  return false;
}

async function adminMove(ctx, tokens, dir) {
  const { engine, serverId: sid } = ctx;
  if (!(await needGiver(ctx, OWNER_ONLY_MOVE))) return undefined;
  const cur = currencyOf();
  const { amount, before, after } = splitAmount(tokens);
  const who = before.join(' ').trim();
  const reason = clip(readableMentions(after.join(' ')).replace(/\s+/g, ' ').trim(), MAX_REASON);
  const verb = dir > 0 ? 'give' : 'take';
  if (amount === null || !who) return ctx.warn(`${dir > 0 ? 'Give' : 'Take'} how much, to whom?`, `Try \`/economy ${verb} @sam 100 prize\`.`);
  if (!validAmount(amount)) return ctx.warn("That amount didn't work", `Amounts start at 1. ${AMOUNT_HELP}`);
  const target = await findMember(ctx, who);
  if (target.problem) return ctx.warn(...target.problem);
  if (isBotMember(engine, target.member, target.id)) return ctx.warn(`Bots can't hold ${cur.name}`, 'Pick a person instead.');
  const actor = await displayName(engine, sid, ctx.userId);
  const t = clock(engine);
  const cfg = cfgOf(ctx.engine);
  const moved = mutateUsers(engine, (doc) => {
    const u = ensureUser(doc, target.id, cfg, t);
    const real = change(u, dir * amount, `${dir > 0 ? 'Given' : 'Taken'} by ${actor}${reason ? `: ${reason}` : ''}`, t);
    return { real: Math.abs(real), bal: u.bal };
  });
  if (!moved.real) return ctx.info('Nothing changed', dir > 0 ? `**${target.name}** is at the wallet limit.` : `**${target.name}** has no ${cur.name} to take.`);
  await modLog(engine, sid, card({ title: `${ICONS.economy} ${cur.name} ${dir > 0 ? 'given' : 'taken'}`, body: `**${actor}** ${dir > 0 ? 'gave' : 'took'} ${money(cur, moved.real)} ${cur.emoji} ${dir > 0 ? 'to' : 'from'} **${target.name}**.${reason ? `\nReason: ${plainName(reason)}` : ''}\nNew balance: ${price(cur, moved.bal)}`, color: 'economy' }));
  const undo = adminUndo(ctx, `${verb} ${fmt(moved.real)}`, async () => {
    const t2 = clock(engine);
    mutateUsers(engine, (doc) => {
      const u = ensureUser(doc, target.id, cfgOf(engine), t2);
      change(u, -dir * moved.real, `Undo: ${dir > 0 ? 'gift' : 'take'} by ${actor}`, t2);
    });
  }, { giver: true });
  const partial = dir < 0 && moved.real < amount ? ` (all they had)` : '';
  return ctx.ok(dir > 0 ? `${cur.name} given` : `${cur.name} taken`, `${dir > 0 ? 'Gave' : 'Took'} ${money(cur, moved.real)} ${cur.emoji}${partial} ${dir > 0 ? 'to' : 'from'} **${target.name}**. They have ${price(cur, moved.bal)} now.`, { components: [row(undo.button)] });
}

async function resetUser(ctx, query) {
  const { engine, serverId: sid } = ctx;
  if (!(await needGiver(ctx, OWNER_ONLY_MOVE))) return undefined;
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn('Reset who?', 'Try `/economy reset @sam`.');
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**.`);
  const name = await displayName(engine, sid, found.id);
  const saved = readUsers(engine).users[found.id];
  if (!saved) return ctx.info('Nothing to reset', `**${name}** has no wallet yet.`);
  mutateUsers(engine, (doc) => { delete doc.users[found.id]; });
  const cur = currencyOf();
  const undo = adminUndo(ctx, `reset of ${clip(name, 30)}`, async () => {
    mutateUsers(engine, (doc) => { doc.users[found.id] = saved; });
  }, { giver: true });
  return ctx.ok('Wallet reset', `**${name}** starts over: their ${price(cur, saved.bal || 0)}, streak, history and inventory are cleared. Roles they bought stay.`, { components: [row(undo.button)] });
}

const DAILY_HELP = `Use a whole number of ${CURRENCY.name}, like \`500\`, \`2k\` or \`5m\` (0 turns daily off).`;
const WORK_HELP = `Use whole numbers of ${CURRENCY.name} from 1 up, like \`/economy work 20 80\`. \`2k\` and \`5m\` work too.`;
const START_HELP = `Use a whole number of ${CURRENCY.name}, like \`0\`, \`500\`, \`2k\` or \`5m\`.`;

function workPair(loText, hiText) {
  const lo = numberIn(loText, { min: 1 });
  const hi = numberIn(hiText ?? loText, { min: 1 });
  if (lo === null || hi === null) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function numberIn(text, { min = 0, max = MAX_SETTING } = {}) {
  const n = parseAmount(String(text ?? '').trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function saveDaily(ctx, text) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const n = numberIn(text, { min: 0 });
  if (n === null) return ctx.warn("That amount didn't work", DAILY_HELP);
  patchCfg(ctx, { dailyAmount: n });
  const cur = currencyOf();
  return ctx.ok('Daily saved', n ? `/daily gives ${price(cur, n)} everywhere, plus up to +${STREAK_MAX}% for streaks.` : '/daily is off now.');
}

async function saveWork(ctx, loText, hiText) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const pair = workPair(loText, hiText);
  if (!pair) return ctx.warn("That pay didn't work", WORK_HELP);
  const [a, b] = pair;
  patchCfg(ctx, { workMin: a, workMax: b });
  const cur = currencyOf();
  return ctx.ok('Work pay saved', `A shift pays ${fmt(a)} to ${fmt(b)} ${cur.emoji}, once an hour, in every server.`);
}

async function saveStart(ctx, text) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const n = numberIn(text, { min: 0 });
  if (n === null) return ctx.warn("That amount didn't work", START_HELP);
  patchCfg(ctx, { startBalance: n });
  const cur = currencyOf();
  return ctx.ok('Starting balance saved', `New wallets start with ${price(cur, n)}. Existing wallets don't change.`);
}

async function saveWorkEnabled(ctx, on) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  patchCfg(ctx, { workEnabled: on });
  return ctx.ok('Saved', on ? '**/balance work** is on everywhere.' : '**/balance work** is off everywhere. /daily still works.');
}

async function listGivers(ctx) {
  if (!(await needGiver(ctx, OWNER_ONLY_MOVE))) return undefined;
  const list = ownerIds(ctx.engine);
  const lines = list.length ? list.map((id) => `• <@${id}>`).join('\n') : 'Nobody yet. Add someone with `/economy allow @sam`.';
  return ctx.ephemeral({ embeds: [card({ title: `${ICONS.economy} Who can hand out ${CURRENCY.name}`, body: `You can, always.
${lines}`, color: 'economy' })] });
}

async function changeGiver(ctx, query, on) {
  if (!ctx.engine.isBotOwner(ctx.userId)) {
    await ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Owner only', body: `Only the bot owner can change who hands out ${CURRENCY.name}.` })] });
    return undefined;
  }
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn(on ? 'Allow who?' : 'Take it from who?', `Try \`/economy ${on ? 'allow' : 'deny'} @sam\`.`);
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**.`);
  const name = await displayName(ctx.engine, ctx.serverId, found.id);
  if (on) {
    allowGiver(ctx.engine, found.id);
    return ctx.ok('Allowed', `**${name}** can hand out ${CURRENCY.name} now, in any server.`);
  }
  denyGiver(ctx.engine, found.id);
  return ctx.ok('Taken back', `**${name}** can't hand out ${CURRENCY.name} anymore.`);
}

const PARTY_HELP = `Try \`/economy party 25 100 500 50\` (a game, a win, a tournament win, a right prediction) or \`/economy party win 150\`. 2nd and 3rd place and win streaks follow the win rate. There is no daily limit.`;
const PAY_HELP = `Try \`/economy earn 3 1 10 500\` (chatting, a voice minute, per level, the weekly bonus) or \`/economy earn chat 5\`. 0 turns one off.`;
const STREAK_HELP = 'Try `/economy streak 50 100 200` (bonus % at day 7, 30 and 100) or `/economy streak 30 150`.';
const LIMITS_HELP = 'Try `/economy events 2 48 30` (highest boost, longest hours, days between events). A highest boost of 1 turns server events off.';

function partyText(r) {
  const second = Math.round((r.win * PARTY_PLACE.second) / 100);
  const third = Math.round((r.win * PARTY_PLACE.third) / 100);
  return `${fmt(r.play)} a game · ${fmt(r.win)} a win · ${fmt(second)} for 2nd and ${fmt(third)} for 3rd with ${PARTY_PLACE.min}+ players · win streaks +${PARTY_WIN_STREAK.step}% a win, up to +${PARTY_WIN_STREAK.max}% · ${fmt(r.tournament)} a tournament win · ${fmt(r.prediction)} a right pick · no daily limit`;
}

function payText(r) {
  return `${fmt(r.chat)} for chatting · ${fmt(r.voice)} a voice minute · ${fmt(r.levelup)} × each new level · ${fmt(r.weekly)} weekly`;
}

function streakText(table) {
  return STREAK_DAYS.map((d) => `day ${d}${d === 100 ? ' (and every 100)' : ''} +${table[d]}%`).join(' · ');
}

function limitsText(l) {
  if (l.mult <= 1) return 'Off';
  return `up to ×${l.mult} for ${l.hours}h, once every ${l.cooldownDays} day${l.cooldownDays === 1 ? '' : 's'} per server`;
}

function pushRates(engine) {
  try {
    Promise.resolve(engine.dashboard?.pushPartyRates?.()).catch((e) => engine.log.debug('[economy] Party rates push failed', e?.message));
  } catch (e) {
    engine.log.debug('[economy] Party rates push failed', e?.message);
  }
}

async function saveParty(ctx, tokens) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const cur = currencyOf();
  const now = partyRates(cfgOf(ctx.engine));
  const next = { ...now };
  const list = tokens.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return ctx.info(`${CURRENCY.emoji} YapOS Party ${cur.name}`, `${partyText(now)}\n${PARTY_HELP}`);
  if (list[0].toLowerCase() === 'cap') return ctx.info('No daily cap', `YapOS Party has no daily limit anymore. Every game with 2 or more signed-in players pays, and fast repeat games pay nothing extra.\n${PARTY_HELP}`);
  const named = PARTY_KEYS.includes(list[0].toLowerCase());
  if (named) {
    for (let i = 0; i < list.length; i += 2) {
      const key = list[i].toLowerCase();
      const n = numberIn(list[i + 1], { min: 0, max: PARTY_BOUNDS[key] ?? 0 });
      if (!PARTY_KEYS.includes(key) || n === null) return ctx.warn("That didn't work", `${key && PARTY_BOUNDS[key] !== undefined ? `**${key}** can be 0 to ${fmt(PARTY_BOUNDS[key])}. ` : ''}${PARTY_HELP}`);
      next[key] = n;
    }
  } else {
    for (let i = 0; i < Math.min(list.length, PARTY_KEYS.length); i++) {
      const key = PARTY_KEYS[i];
      const n = numberIn(list[i], { min: 0, max: PARTY_BOUNDS[key] });
      if (n === null) return ctx.warn("That didn't work", `**${key}** can be 0 to ${fmt(PARTY_BOUNDS[key])}. ${PARTY_HELP}`);
      next[key] = n;
    }
  }
  patchCfg(ctx, { partyRates: next });
  pushRates(ctx.engine);
  return ctx.ok('Party rates saved', `YapOS Party now pays ${partyText(partyRates({ partyRates: next }))} ${cur.emoji}, for games with 2 or more players.`);
}

async function saveActivityPay(ctx, tokens) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const now = activityPay(cfgOf(ctx.engine));
  const next = { ...now };
  const list = tokens.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return ctx.info(`${CURRENCY.emoji} Activity pay`, `${payText(now)}\n${PAY_HELP}`);
  if (PAY_KEYS.includes(list[0].toLowerCase())) {
    for (let i = 0; i < list.length; i += 2) {
      const key = list[i].toLowerCase();
      const n = numberIn(list[i + 1], { min: 0, max: PAY_BOUNDS[key] ?? 0 });
      if (!PAY_KEYS.includes(key) || n === null) return ctx.warn("That didn't work", `${PAY_BOUNDS[key] !== undefined ? `**${key}** can be 0 to ${fmt(PAY_BOUNDS[key])}. ` : ''}${PAY_HELP}`);
      next[key] = n;
    }
  } else {
    for (let i = 0; i < Math.min(list.length, PAY_KEYS.length); i++) {
      const key = PAY_KEYS[i];
      const n = numberIn(list[i], { min: 0, max: PAY_BOUNDS[key] });
      if (n === null) return ctx.warn("That didn't work", `**${key}** can be 0 to ${fmt(PAY_BOUNDS[key])}. ${PAY_HELP}`);
      next[key] = n;
    }
  }
  patchCfg(ctx, { activityPay: next });
  return ctx.ok('Activity pay saved', `${payText(next)} ${currencyOf().emoji}.`);
}

async function saveStreak(ctx, tokens) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const now = streakTable(cfgOf(ctx.engine));
  const list = tokens.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return ctx.info('Streak rewards', `${streakText(now)}\n${STREAK_HELP}`);
  const next = { ...now };
  if (list.length === 2 && STREAK_DAYS.includes(Number(list[0]))) {
    const n = numberIn(list[1].replace(/%$/, ''), { min: 0, max: STREAK_PCT_MAX });
    if (n === null) return ctx.warn("That didn't work", `Use 0 to ${STREAK_PCT_MAX} percent. ${STREAK_HELP}`);
    next[Number(list[0])] = n;
  } else {
    for (let i = 0; i < Math.min(list.length, STREAK_DAYS.length); i++) {
      const n = numberIn(list[i].replace(/%$/, ''), { min: 0, max: STREAK_PCT_MAX });
      if (n === null) return ctx.warn("That didn't work", `Use 0 to ${STREAK_PCT_MAX} percent. ${STREAK_HELP}`);
      next[STREAK_DAYS[i]] = n;
    }
  }
  patchCfg(ctx, { streakRewards: next });
  return ctx.ok('Streak rewards saved', `${streakText(next)}. The bonus is a share of the daily amount, paid once on that day.`);
}

function multIn(text) {
  const n = Number(String(text ?? '').trim().toLowerCase().replace(/^x|x$/g, ''));
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

async function saveLimits(ctx, tokens) {
  if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
  const now = eventLimits(cfgOf(ctx.engine));
  const list = tokens.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return ctx.info('Server event limits', `${limitsText(now)}\n${LIMITS_HELP}`);
  const mult = multIn(list[0]);
  const hours = list[1] === undefined ? now.hours : Number(String(list[1]).replace(/h$/i, ''));
  const days = list[2] === undefined ? now.cooldownDays : Number(String(list[2]).replace(/d$/i, ''));
  if (mult === null || mult < 1 || mult > EVENT_MULT_MAX) return ctx.warn("That boost didn't work", `Use 1 to ${EVENT_MULT_MAX}, like 2. ${LIMITS_HELP}`);
  if (!Number.isInteger(hours) || hours < 1 || hours > EVENT_HOURS_MAX) return ctx.warn("Those hours didn't work", `Use whole hours from 1 to ${EVENT_HOURS_MAX}. ${LIMITS_HELP}`);
  if (!Number.isInteger(days) || days < 0 || days > EVENT_DAYS_MAX) return ctx.warn("Those days didn't work", `Use whole days from 0 to ${EVENT_DAYS_MAX}. ${LIMITS_HELP}`);
  const next = { mult, hours, cooldownDays: days };
  patchCfg(ctx, { eventLimits: next });
  return ctx.ok('Event limits saved', next.mult <= 1 ? 'Server events are off everywhere. Events already running finish on time.' : `Admins can run events ${limitsText(next)}.`);
}

function eventState(engine, sid, t = clock(engine)) {
  const doc = readDoc(engine, sid);
  const limits = eventLimits(cfgOf(engine));
  const ev = activeEvent(engine, sid, t);
  const last = Number(doc.lastEventAt) || 0;
  const readyAt = last ? last + limits.cooldownDays * DAY : 0;
  return { ev, limits, last, readyAt, waiting: !ev && readyAt > t };
}

async function eventView(ctx) {
  const { engine, serverId: sid } = ctx;
  const t = clock(engine);
  const st = eventState(engine, sid, t);
  const isAdmin = engine.perms.atLeast(await ctx.level(), 'admin');
  const fields = [
    { name: 'Right now', value: st.ev ? `${EVENT_KINDS[st.ev.kind].icon} **${boostName(st.ev.kind, st.ev.mult)}** · ends in ${spanText(st.ev.endsAt - t)}` : 'No event running', inline: false },
    { name: 'Limits from the bot owner', value: limitsText(st.limits), inline: false },
  ];
  if (!st.ev && st.limits.mult > 1) fields.push({ name: 'Next event', value: st.waiting ? `in ${spanText(st.readyAt - t)}` : 'Ready to start', inline: true });
  const body = `A server event boosts what people earn **in this server** for a while: XP from chatting and voice, or ${CURRENCY.name} from /daily, work, begging, quests and trivia wins. Casino winnings never change.`;
  const btns = [];
  if (isAdmin && st.ev) btns.push(button('End event', cid('evstop'), 'danger', '⏹️'));
  if (isAdmin && !st.ev && !st.waiting && st.limits.mult > 1) {
    btns.push(button(`Start ${boostName('xp', st.limits.mult)}`, cid('evform', 'xp'), 'primary', EVENT_KINDS.xp.icon));
    btns.push(button(`Start ${boostName('shards', st.limits.mult)}`, cid('evform', 'shards'), 'primary', EVENT_KINDS.shards.icon));
  }
  if (canGiveCurrency(engine, ctx.userId)) btns.push(button('Limits', cid('evlimitform'), 'secondary', '⚙️'));
  return { embeds: [card({ title: '🎪 Server events', body, fields, color: 'economy' })], components: btns.length ? [row(btns)] : [] };
}

const KIND_WORDS = { xp: 'xp', exp: 'xp', level: 'xp', levels: 'xp', shards: 'shards', shard: 'shards', coins: 'shards', money: 'shards', currency: 'shards' };

async function startEvent(ctx, kindWord, rest) {
  const { engine, serverId: sid } = ctx;
  await ctx.require('admin');
  const kind = KIND_WORDS[String(kindWord || '').toLowerCase()];
  if (!kind) return ctx.warn('Which event?', 'Try `/event xp 48h` for Double XP or `/event shards 24h` for Double Shards.');
  if (kind === 'xp' && !engine.apps?.has?.('levels')) return ctx.warn("Levels isn't running", 'A Double XP event needs the Levels app.');
  const t = clock(engine);
  const st = eventState(engine, sid, t);
  if (st.limits.mult <= 1) return ctx.info('Server events are off', 'The bot owner has switched server events off for now.');
  if (st.ev) return ctx.warn('An event is already running', `**${boostName(st.ev.kind, st.ev.mult)}** ends in ${spanText(st.ev.endsAt - t)}. End it with \`/event stop\` first.`);
  if (st.waiting) return ctx.warn('Not yet', `Each server gets one event every ${st.limits.cooldownDays} days. The next one can start in **${spanText(st.readyAt - t)}**.`);
  const tokens = rest.map((x) => String(x ?? '').trim()).filter(Boolean);
  let ms = st.limits.hours * HOUR;
  let mult = st.limits.mult;
  for (const tok of tokens) {
    if (/^x?\d+(?:\.\d+)?x$|^x\d+(?:\.\d+)?$/i.test(tok)) {
      const m = multIn(tok);
      if (m === null || m <= 1 || m > st.limits.mult) return ctx.warn("That boost didn't work", `The bot owner allows up to ×${st.limits.mult}. Try \`2x\`.`);
      mult = m;
      continue;
    }
    const d = parseDuration(tok, { bareUnit: 'h' });
    if (d === null) return ctx.warn("I couldn't read that length", 'Try something like `24h`, `2d` or `36`.');
    ms = d;
  }
  if (ms < HOUR || ms > st.limits.hours * HOUR) return ctx.warn('That length is outside the limit', `Events can last from 1 hour up to **${st.limits.hours} hours** (the bot owner's limit).`);
  const ev = { kind, mult, startedAt: t, endsAt: t + ms, by: ctx.userId };
  const ok = mutate(engine, sid, (doc) => {
    const cur = doc.event && Number(doc.event.endsAt) > t ? doc.event : null;
    if (cur) return false;
    doc.event = ev;
    doc.lastEventAt = t;
    return true;
  });
  if (!ok) return ctx.warn('An event is already running', 'Someone started one just now.');
  const what = kind === 'xp' ? 'XP from chatting and voice' : `${CURRENCY.name} from /daily, work, begging, quests and trivia wins`;
  const body = `For the next **${spanText(ms)}**, ${what} counts ×${mult} in this server.\nCheck it any time with **/event**.`;
  return ctx.reply({ embeds: [card({ title: `${EVENT_KINDS[kind].icon} ${boostName(kind, mult)} is on!`, body, color: 'economy', footer: false })] });
}

async function stopEvent(ctx, how = 'reply') {
  const { engine, serverId: sid } = ctx;
  await ctx.require('admin');
  const t = clock(engine);
  const ended = mutate(engine, sid, (doc) => {
    if (!doc.event || !(Number(doc.event.endsAt) > t)) return null;
    const was = { ...doc.event };
    doc.event.endsAt = t;
    return was;
  });
  if (!ended) return ctx.info('No event running', 'There is nothing to end right now.');
  const limits = eventLimits(cfgOf(engine));
  const embed = dialog.ok('Event ended', `**${boostName(ended.kind, ended.mult)}** is over. The next event can start ${limits.cooldownDays ? `in ${spanText(ended.startedAt + limits.cooldownDays * DAY - t)}` : 'any time'}.`);
  if (how === 'update') return ctx.update({ embeds: [embed], components: [] });
  return ctx.ephemeral({ embeds: [embed] });
}

async function runEvent(ctx) {
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || ['status', 'info', 'panel'].includes(sub)) return ctx.panel(await eventView(ctx));
  if (['stop', 'end', 'cancel'].includes(sub)) return stopEvent(ctx);
  if (['limits', 'limit'].includes(sub)) return saveLimits(ctx, rest);
  if (sub === 'start') return startEvent(ctx, rest[0], rest.slice(1));
  if (KIND_WORDS[sub]) return startEvent(ctx, sub, rest);
  if (['double', 'triple'].includes(sub) && KIND_WORDS[(rest[0] || '').toLowerCase()]) return startEvent(ctx, rest[0], [sub === 'triple' ? '3x' : '2x', ...rest.slice(1)]);
  const guess = didYouMean(sub, ['xp', 'shards', 'stop', 'limits']);
  return ctx.warn("I didn't get that", `I don't know **${plainName(clip(sub, 30))}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/event\`, \`/event xp 48h\`, \`/event shards 24h\` or \`/event stop\`.`);
}

const ECON_SUBS = ['give', 'take', 'reset', 'daily', 'work', 'start', 'allow', 'deny', 'givers', 'settings', 'party', 'earn', 'streak', 'events'];

const globalField = (field) => ({
  ...field,
  owner: true,
  read: (cfg) => (eng ? cfgOf(eng)[field.key] : cfg[field.key]),
  save: async (ctx, value, all) => {
    if (!canGiveCurrency(ctx.engine, ctx.userId)) return { error: OWNER_ONLY_EARN };
    if (typeof field.save === 'function') return field.save(ctx, value, all);
    patchCfg(ctx, { [field.key]: value });
    return undefined;
  },
});

const amountField = (key, label, help, min, error) => ({
  key, label, help, type: 'number', web: true, min, max: MAX_SETTING, step: 1,
  validate: (ctx, v) => {
    const n = numberIn(v, { min });
    return n === null ? reject(error) : accept(n);
  },
});

const workField = (key, label, help) => ({
  ...amountField(key, label, help, 1, WORK_HELP),
  save: (ctx, value, all) => {
    const cfg = cfgOf(ctx.engine);
    const other = key === 'workMin' ? 'workMax' : 'workMin';
    const otherValue = all && all[other] !== undefined && numberIn(all[other], { min: 1 }) !== null ? numberIn(all[other], { min: 1 }) : cfg[other];
    const pair = key === 'workMin' ? workPair(value, otherValue) : workPair(otherValue, value);
    if (!pair) return { error: WORK_HELP };
    patchCfg(ctx, { workMin: pair[0], workMax: pair[1] });
    return { applied: { workMin: pair[0], workMax: pair[1] } };
  },
});

const DASHBOARD = [
  globalField(amountField('dailyAmount', 'Daily reward', `${CURRENCY.name} from /daily, before the streak bonus. 0 turns /daily off. Set once for every server.`, 0, DAILY_HELP)),
  globalField(workField('workMin', 'Work pay (lowest)', 'The least a shift of /balance work pays, in every server.')),
  globalField(workField('workMax', 'Work pay (highest)', 'The most a shift of /balance work pays, in every server.')),
  globalField(boolField({ key: 'workEnabled', label: '/balance work enabled', help: `Lets people earn ${CURRENCY.name} once an hour with /balance work.` })),
  globalField(boolField({ key: 'begEnabled', label: '/beg enabled', help: `Lets people beg for a few ${CURRENCY.name}.` })),
  globalField(amountField('startBalance', 'Starting balance', `${CURRENCY.name} every new wallet starts with. Existing wallets do not change.`, 0, START_HELP)),
];

async function runEconomy(ctx) {
  await ctx.require('admin');
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || sub === 'settings' || sub === 'panel') return showSettings(ctx);
  if (['give', 'add', 'grant'].includes(sub)) return adminMove(ctx, rest, 1);
  if (['take', 'remove', 'deduct'].includes(sub)) return adminMove(ctx, rest, -1);
  if (sub === 'reset') return resetUser(ctx, rest.join(' '));
  if (sub === 'currency' || sub === 'name' || sub === 'emoji') {
    return ctx.info('One currency everywhere', `YapOS pays in ${CURRENCY.emoji} ${CURRENCY.name} in every server, so there is nothing to change.`);
  }
  if (sub === 'allow') return changeGiver(ctx, rest.join(' '), true);
  if (sub === 'deny') return changeGiver(ctx, rest.join(' '), false);
  if (['givers', 'allowed'].includes(sub)) return listGivers(ctx);
  if (sub === 'daily') return saveDaily(ctx, rest[0]);
  if (sub === 'work') {
    const v = (rest[0] || '').toLowerCase();
    if (['on', 'off', 'enable', 'disable', 'yes', 'no'].includes(v)) return saveWorkEnabled(ctx, ['on', 'enable', 'yes'].includes(v));
    if (!rest.length) return ctx.warn('Work pay', 'Try `/economy work 20 80`, `/economy work on` or `/economy work off`.');
    return saveWork(ctx, rest[0], rest[1]);
  }
  if (sub === 'start' || sub === 'starting') return saveStart(ctx, rest[0]);
  if (sub === 'party') return saveParty(ctx, rest);
  if (['earn', 'pay', 'activity'].includes(sub)) return saveActivityPay(ctx, rest);
  if (['chat', 'voice', 'levelup', 'weekly'].includes(sub)) return saveActivityPay(ctx, tokens);
  if (sub === 'streak' || sub === 'streaks') return saveStreak(ctx, rest);
  if (sub === 'events' || sub === 'event') return saveLimits(ctx, rest);
  const guess = didYouMean(sub, ECON_SUBS);
  return ctx.warn("I didn't get that", `I don't know **${plainName(clip(sub, 30))}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}
Try \`/economy\` on its own for the settings panel.`);
}

const admin = (run) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const rateOwner = (run) => admin(async (ctx) => ((await needGiver(ctx, OWNER_ONLY_EARN)) ? run(ctx) : undefined));
const moveOwner = (run) => admin(async (ctx) => ((await needGiver(ctx, OWNER_ONLY_MOVE)) ? run(ctx) : undefined));
const refresh = async (ctx) => (ownsPanel(ctx) ? ctx.update(await settingsView(ctx)) : ctx.ephemeral(await settingsView(ctx)));
const ownerOnly = (argIndex, run) => ({
  run: async (ctx) => {
    if (ctx.argv[argIndex] !== ctx.userId) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Not yours', body: 'This button is for the person who opened it. Run the command yourself to get your own.' })] });
    return run(ctx);
  },
});

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Economy',
  icon: ICONS.economy,
  description: `${CURRENCY.name}, daily rewards, work, payments and a shop.`,
  category: 'Fun',
  panelPerm: 'member',

  defaults: {
    dailyAmount: 100,
    workMin: 20,
    workMax: 80,
    workEnabled: true,
    begEnabled: true,
    startBalance: 0,
    partyRates: { ...PARTY_DEFAULTS },
    activityPay: { ...PAY_DEFAULTS },
    streakRewards: { ...STREAK_DEFAULTS },
    eventLimits: { ...EVENT_DEFAULTS },
  },

  commands: {
    daily: { description: 'Claim your daily Shards: /daily, /daily weekly (weekly bonus), /daily earn (all ways to earn)', run: runDaily },
    beg: { description: 'Beg for a few Shards. Sometimes people help, sometimes not: /beg', run: doBeg },
    balance: { description: 'Your wallet: /balance, /balance @sam, /balance pay @sam 50, work, top, history', run: (ctx) => runBalance(ctx) },
    shop: { description: 'The server shop: /shop, /shop buy Name. Admins: /shop add role @Supporter 500', run: runShop },
    economy: { description: 'Economy settings: /economy give @sam 100, take, reset @sam, daily 150, allow @sam', perm: 'admin', run: runEconomy },
    event: { description: 'Server events: /event, admins: /event xp 48h (Double XP), /event shards 24h, /event stop', run: runEvent },
  },

  components: {
    daily: { run: claimDaily },
    weekly: { run: claimWeekly },
    earn: { run: async (ctx) => ctx.ephemeral(earnView(ctx.engine)) },
    work: { run: doWork },
    beg: { run: doBeg },
    top: { run: async (ctx) => ctx.reply(await topView(ctx)) },
    season: { run: async (ctx) => ctx.reply(await seasonView(ctx)) },
    history: { run: (ctx) => showHistory(ctx, '') },
    wallet: { run: async (ctx) => ctx.ephemeral(await walletView(ctx, ctx.userId, { self: true })) },
    pick: { run: (ctx) => openBuy(ctx, (ctx.values || [])[0]) },
    buy: { run: (ctx) => openBuy(ctx, ctx.argv[0]) },
    buyok: ownerOnly(1, completeBuy),
    buyno: ownerOnly(1, (ctx) => {
      const ticket = ctx.engine.router.getSession(ctx.argv[0]);
      if (ticket?.kind === 'buy' && ticket.uid === ctx.userId) ctx.engine.router.dropSession(ctx.argv[0]);
      return ctx.update({ embeds: [dialog.info('Canceled', 'Nothing was bought.')], components: [] });
    }),
    payok: ownerOnly(1, async (ctx) => {
      const s = ctx.engine.router.getSession(ctx.argv[0]);
      if (!s || s.sid !== ctx.serverId || s.from !== ctx.userId) return ctx.update({ embeds: [dialog.info('Already handled', 'This payment was already sent, canceled or expired. Nothing more happened.')], components: [] });
      ctx.engine.router.dropSession(ctx.argv[0]);
      return finishPay(ctx, s, 'update');
    }),
    payno: ownerOnly(1, (ctx) => {
      ctx.engine.router.dropSession(ctx.argv[0]);
      return ctx.update({ embeds: [dialog.info('Canceled', `No ${CURRENCY.name} were sent.`)], components: [] });
    }),
    twork: admin(async (ctx) => {
      if (!(await needGiver(ctx, OWNER_ONLY_EARN))) return undefined;
      patchCfg(ctx, { workEnabled: cfgOf(ctx.engine).workEnabled === false });
      return refresh(ctx);
    }),
    dailyform: rateOwner((ctx) => ctx.form({ title: 'Daily amount', action: 'dailysave', fields: [
      { id: 'amount', label: `${CURRENCY.name} per /daily (0 turns it off)`, style: 'short', value: String(clampSetting(cfgOf(ctx.engine).dailyAmount, 100)), max: 20 },
    ] })),
    dailysave: rateOwner((ctx) => saveDaily(ctx, ctx.values?.amount)),
    workform: rateOwner((ctx) => ctx.form({ title: 'Work pay', action: 'worksave', fields: [
      { id: 'min', label: 'Lowest pay per shift', style: 'short', value: String(clampSetting(cfgOf(ctx.engine).workMin, 20)), max: 20 },
      { id: 'max', label: 'Highest pay per shift', style: 'short', value: String(clampSetting(cfgOf(ctx.engine).workMax, 80)), max: 20 },
    ] })),
    worksave: rateOwner((ctx) => saveWork(ctx, ctx.values?.min, ctx.values?.max)),
    startform: rateOwner((ctx) => ctx.form({ title: 'Starting balance', action: 'startsave', fields: [
      { id: 'amount', label: `${CURRENCY.name} a new wallet starts with`, style: 'short', value: String(clampSetting(cfgOf(ctx.engine).startBalance, 0)), max: 20 },
    ] })),
    startsave: rateOwner((ctx) => saveStart(ctx, ctx.values?.amount)),
    giveform: moveOwner((ctx) => ctx.form({ title: `Give ${CURRENCY.name}`, action: 'givesave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
      { id: 'amount', label: 'How many?', style: 'short', placeholder: '100', max: 20 },
      { id: 'reason', label: 'Reason (optional)', style: 'short', required: false, max: MAX_REASON },
    ] })),
    givesave: moveOwner((ctx) => adminMove(ctx, [...tokenize(ctx.values?.user), String(ctx.values?.amount ?? '').trim() || 'x', ...tokenize(ctx.values?.reason)], 1)),
    takeform: moveOwner((ctx) => ctx.form({ title: `Take ${CURRENCY.name}`, action: 'takesave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
      { id: 'amount', label: 'How many?', style: 'short', placeholder: '100', max: 20 },
      { id: 'reason', label: 'Reason (optional)', style: 'short', required: false, max: MAX_REASON },
    ] })),
    takesave: moveOwner((ctx) => adminMove(ctx, [...tokenize(ctx.values?.user), String(ctx.values?.amount ?? '').trim() || 'x', ...tokenize(ctx.values?.reason)], -1)),
    resetform: moveOwner((ctx) => ctx.form({ title: 'Reset a wallet', action: 'resetsave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
    ] })),
    resetsave: moveOwner((ctx) => resetUser(ctx, ctx.values?.user)),
    partyform: rateOwner((ctx) => {
      const r = partyRates(cfgOf(ctx.engine));
      return ctx.form({ title: 'YapOS Party pay', action: 'partysave', fields: PARTY_KEYS.map((k) => (
        { id: k, label: `${CURRENCY.name} for ${PARTY_LABELS[k]} (0 to ${fmt(PARTY_BOUNDS[k])})`, style: 'short', value: String(r[k]), max: 5 }
      )) });
    }),
    partysave: rateOwner((ctx) => saveParty(ctx, PARTY_KEYS.flatMap((k) => [k, String(ctx.values?.[k] ?? '').trim() || 'x']))),
    payform: rateOwner((ctx) => {
      const r = activityPay(cfgOf(ctx.engine));
      return ctx.form({ title: 'Activity pay', action: 'paysave', fields: PAY_KEYS.map((k) => (
        { id: k, label: clip(`${CURRENCY.name} for ${PAY_LABELS[k]} (0 to ${fmt(PAY_BOUNDS[k])})`, 45), style: 'short', value: String(r[k]), max: 6 }
      )) });
    }),
    paysave: rateOwner((ctx) => saveActivityPay(ctx, PAY_KEYS.flatMap((k) => [k, String(ctx.values?.[k] ?? '').trim() || 'x']))),
    streakform: rateOwner((ctx) => {
      const tb = streakTable(cfgOf(ctx.engine));
      return ctx.form({ title: 'Streak rewards', action: 'streaksave', fields: STREAK_DAYS.map((d) => (
        { id: `d${d}`, label: `Bonus % of the daily at day ${d}${d === 100 ? ' (and every 100)' : ''}`, style: 'short', value: String(tb[d]), max: 4 }
      )) });
    }),
    streaksave: rateOwner((ctx) => saveStreak(ctx, STREAK_DAYS.map((d) => String(ctx.values?.[`d${d}`] ?? '').trim() || 'x'))),
    evlimitform: rateOwner((ctx) => {
      const l = eventLimits(cfgOf(ctx.engine));
      return ctx.form({ title: 'Server event limits', action: 'evlimitsave', fields: [
        { id: 'mult', label: `Highest boost (1 turns events off, up to ${EVENT_MULT_MAX})`, style: 'short', value: String(l.mult), max: 4 },
        { id: 'hours', label: `Longest event in hours (1 to ${EVENT_HOURS_MAX})`, style: 'short', value: String(l.hours), max: 4 },
        { id: 'days', label: 'Days between events per server', style: 'short', value: String(l.cooldownDays), max: 4 },
      ] });
    }),
    evlimitsave: rateOwner((ctx) => saveLimits(ctx, [ctx.values?.mult, ctx.values?.hours, ctx.values?.days].map((v) => String(v ?? '').trim() || 'x'))),
    evform: admin((ctx) => {
      const kind = ctx.argv[0] === 'shards' ? 'shards' : 'xp';
      const l = eventLimits(cfgOf(ctx.engine));
      return ctx.form({ title: `Start ${boostName(kind, l.mult)}`, action: 'evsave', args: [kind], fields: [
        { id: 'hours', label: `How long? (up to ${l.hours}h, like 24h or 2d)`, style: 'short', value: `${l.hours}h`, max: 10 },
      ] });
    }),
    evsave: admin((ctx) => startEvent(ctx, ctx.argv[0], [String(ctx.values?.hours ?? '').trim()].filter(Boolean))),
    evstop: admin((ctx) => stopEvent(ctx, 'update')),
  },

  yap: [
    { words: ['daily'], run: runDaily },
    { words: ['earn', 'income'], run: async (ctx) => ctx.reply(earnView(ctx.engine)) },
    { words: ['event', 'events', 'boost'], run: (ctx) => runEvent(ctx) },
    { words: ['beg', 'plead'], run: doBeg },
    { words: ['balance', 'bal', 'wallet', 'coins', 'shards', 'money'], run: (ctx) => runBalance(ctx, ctx.argv) },
    { words: ['pay', 'work', 'richest'], run: (ctx) => runBalance(ctx, [ctx.word, ...ctx.argv]) },
    { words: ['shop', 'store', 'buy'], run: (ctx) => (ctx.word === 'buy' ? runShopTokens(ctx, ['buy', ...ctx.argv]) : runShopTokens(ctx, ctx.argv)) },
    {
      words: ['economy'],
      run: async (ctx) => {
        if (!ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showWallet(ctx, '', 'reply');
        return runEconomy(ctx);
      },
    },
  ],

  panel: async (ctx) => {
    if (ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showSettings(ctx);
    return ctx.ephemeral(await walletView(ctx, ctx.userId, { self: true }));
  },

  dashboard: DASHBOARD,

  events: {
    'xp:gained': onXp,
  },

  services: (engine) => ({
    ranked: (sid) => ranked(engine),
    currency: (sid) => currencyOf(),
    balance: (sid, uid) => {
      needIds(sid, uid);
      if (uid === botId(engine)) return 0;
      return balanceOf(engine, uid);
    },
    add: (sid, uid, amount, reason) => serviceAdd(engine, sid, uid, amount, reason),
    take: (sid, uid, amount, reason) => serviceTake(engine, sid, uid, amount, reason),
    transfer: (sid, fromId, toId, amount, reason) => serviceTransfer(engine, sid, fromId, toId, amount, reason),
    ownerAdjust: (uid, mode, amount, reason) => ownerAdjust(engine, uid, mode, amount, reason),
    setStreak: (uid, n) => setStreak(engine, uid, n),
    maxBalance: () => MAX_BALANCE,
    enabled: (sid) => engine.settings.isEnabled(sid, ID),
    seasonBoard: () => seasonBoard(engine, 'shards'),
    seasonScore: (uid) => seasonScore(engine, 'shards', uid),
    partyRates: () => partyRates(cfgOf(engine)),
    activityPay: () => activityPay(cfgOf(engine)),
    earnLines: () => earnLines(engine),
    eventMultiplier: (sid, kind) => eventMultiplier(engine, sid, kind),
    activeEvent: (sid) => {
      const ev = activeEvent(engine, sid);
      return ev ? { kind: ev.kind, mult: Number(ev.mult) || 1, startedAt: ev.startedAt, endsAt: ev.endsAt, name: boostName(ev.kind, Number(ev.mult) || 1) } : null;
    },
    eventBanner: (sid) => eventBanner(engine, sid),
    streak: (uid) => {
      const u = readUsers(engine).users[uid];
      const t = clock(engine);
      return u && u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS ? Math.max(0, Math.floor(Number(u.streak) || 0)) : 0;
    },
  }),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: false, config: {} },
    community: { enabled: true, config: {} },
    roleplay: { enabled: true, config: {} },
  },

  help: [
    `Your wallet of ${CURRENCY.emoji} ${CURRENCY.name} and your level follow you to every server YapOS is in.`,
    '/daily gives Shards once a day. Claim again within 48 hours to keep your streak: +10% for each streak day, up to +100% from day 10. One claim per person, not per server.',
    '/balance work pays a little once an hour. Pay a friend with /balance pay @sam 50 (over 1,000 asks you to confirm). /balance top is the one global leaderboard, /balance history your last 20 changes.',
    `Seasons: ${CURRENCY.name} earned this month count toward /balance season. The top 10 at month end keep a badge on /rank. Wallets never reset.`,
    'Admins run the shop here: /shop add role @Supporter 500 · /shop add item "Golden ticket" 200 · /shop stock 1 10 · /shop price 1 750 · /shop remove 1',
    `Only the bot owner hands out ${CURRENCY.name} or changes earn rates: /economy give @sam 100 · /economy daily 150 · /economy allow @sam lets someone else help.`,
    'Streak rewards: reaching a 7, 30 or 100-day streak (and every 100 after) pays a one-time bonus on top of that day\'s /daily (by default +50%, +100% and +200% of the daily amount).',
    `Server events: admins start a Double XP or Double ${CURRENCY.name} event with /event xp 48h or /event shards 24h. It only counts in that server, ends on its own and, by default, can run once every 30 days (the bot owner sets the limits).`,
    `YapOS Party pays ${CURRENCY.name} with no daily limit: ${PARTY_DEFAULTS.play} for every game with 2 or more signed-in players, ${PARTY_DEFAULTS.win} more for a win, ${Math.round((PARTY_DEFAULTS.win * PARTY_PLACE.second) / 100)} for 2nd and ${Math.round((PARTY_DEFAULTS.win * PARTY_PLACE.third) / 100)} for 3rd in scored games with ${PARTY_PLACE.min} or more players, a win streak bonus of +${PARTY_WIN_STREAK.step}% of a win for each win in a row after the first (up to +${PARTY_WIN_STREAK.max}%), ${PARTY_DEFAULTS.tournament} for a tournament win, ${PARTY_DEFAULTS.prediction} for a right prediction and ${PARTY_DAILY_PUZZLE} for each daily puzzle, plus a puzzle streak bonus (by default). Games played back to back faster than 30 seconds pay nothing extra, and banned players earn nothing.`,
    `More ways to earn: chatting pays ${PAY_DEFAULTS.chat} at most once a minute, voice with friends ${PAY_DEFAULTS.voice} a minute, each new level ${PAY_DEFAULTS.levelup} × the level, and /daily weekly ${PAY_DEFAULTS.weekly} every 7 days (by default). Clan members get +${Math.round(CLAN_PAY_BONUS * 100)}% on chat and voice pay. See it all with /balance earn or /daily earn.`,
    'Bot owner: /economy earn 3 1 10 500 sets chat, voice, level-up and weekly pay, /economy earn chat 5 changes one, and /economy party 25 100 500 50 sets Party pay.',
  ],

  init: (engine) => {
    eng = engine;
    migrate(engine);
  },

  dispose: (engine) => { busy.clear(); warned.clear(); if (engine) payTrackers.delete(engine); eng = null; },
});

async function runShopTokens(ctx, tokens) {
  ctx.argv = tokens;
  return runShop(ctx);
}
