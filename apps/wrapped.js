import { defineApp } from '../engine/apps.js';
import { card, button, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, clip, formatDuration, didYouMean } from '../engine/parse.js';
import { messageLink } from '../engine/links.js';
import { partsAt, isTimeZone } from '../engine/scheduler.js';
import { isPublicChannel } from '../engine/visibility.js';

const ID = 'wrapped';
const cid = (action, ...args) => customId(ID, action, ...args);

const GREEN = 0x1db954;
const FLUSH_MS = 5000;
const MAX_USERS = 5000;
const MAX_EMOJIS = 50;
const MAX_USER_EMOJIS = 8;
const MAX_USER_CHANNELS = 20;
const MAX_CHANNELS = 200;
const MAX_REACTED = 100;
const MAX_SEEN = 20000;
const MAX_BOTS = 1000;
const MOM_TRIES = 10;
const SESSION_CAP_S = 12 * 3600;
const STALE_SESSION_MS = 24 * 3600_000;
const LATE_SKIP_MS = 3 * 86_400_000;
const POST_KIND = `${ID}.post`;
const POST_KEY = 'monthly';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LAST_WORDS = ['last', 'previous', 'prev', 'lastmonth'];
const THIS_WORDS = ['this', 'now', 'current', 'month'];
const SERVER_WORDS = ['server', 'everyone', 'all', 'guild'];

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { docs: new Map(), timers: new Map(), seen: new Map(), bots: new Map(), exitHook: null };
    states.set(engine, s);
  }
  return s;
}

function remember(map, key, value, cap) {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

const validKey = (k) => /^\d{4}-\d{2}$/.test(String(k || ''));

const botId = (engine) => engine.bot.me?.id;
const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${Math.round(Number(n) || 0) === 1 ? '' : 's'}`;

export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(key, by) {
  const [y, m] = String(key).split('-').map(Number);
  return monthKey(Date.UTC(y, m - 1 + by, 1));
}

function monthLabel(key) {
  const [y, m] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function daysIn(key) {
  const [y, m] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const blankMonth = () => ({ msgs: 0, hours: Array(24).fill(0), dow: Array(7).fill(0), ch: {}, emojis: {}, vs: 0, reacted: {}, users: {} });
const blankUser = () => ({ m: 0, ch: {}, h: {}, d: [], rg: 0, rr: 0, vs: 0, e: {} });

function fillMonth(m) {
  const out = { ...blankMonth(), ...(m || {}) };
  if (!Array.isArray(out.hours) || out.hours.length !== 24) out.hours = Array(24).fill(0);
  if (!Array.isArray(out.dow) || out.dow.length !== 7) out.dow = Array(7).fill(0);
  for (const k of ['ch', 'emojis', 'reacted', 'users']) if (!out[k] || typeof out[k] !== 'object') out[k] = {};
  return out;
}

function pruneMonths(doc, current) {
  const oldest = shiftMonth(current, -1);
  const months = {};
  for (const [k, v] of Object.entries(doc?.months || {})) if (validKey(k) && k >= oldest) months[k] = fillMonth(v);
  return { v: 1, months };
}

function bump(map, key, by = 1, cap = Infinity) {
  if (!(key in map) && Object.keys(map).length >= cap) {
    let low = null;
    for (const [k, v] of Object.entries(map)) if (low === null || v < map[low]) low = k;
    if (low !== null) {
      const floor = Math.max(0, Number(map[low]) || 0);
      delete map[low];
      map[key] = floor + by;
      return;
    }
  }
  map[key] = (map[key] || 0) + by;
}

function unbump(map, key, by = 1) {
  if (!(key in map)) return;
  const next = (Number(map[key]) || 0) - by;
  if (next > 0) map[key] = next;
  else delete map[key];
}

function scheduleFlush(engine, sid) {
  const st = stateOf(engine);
  if (st.timers.has(sid)) return;
  const ms = Number.isFinite(engine.config?.wrappedFlushMs) ? engine.config.wrappedFlushMs : FLUSH_MS;
  const t = setTimeout(() => { st.timers.delete(sid); flush(engine, sid); }, ms);
  t.unref?.();
  st.timers.set(sid, t);
}

export function flush(engine, sid) {
  const st = stateOf(engine);
  const t = st.timers.get(sid);
  if (t) { clearTimeout(t); st.timers.delete(sid); }
  const doc = st.docs.get(sid);
  if (!doc) return;
  st.docs.delete(sid);
  try {
    engine.store.set(ID, sid, doc);
  } catch (e) {
    engine.log.error('[wrapped] could not save the monthly counts', e);
  }
}

function flushAll(engine) {
  const st = states.get(engine);
  if (!st) return;
  for (const sid of [...st.docs.keys()]) flush(engine, sid);
}

function working(engine, sid, key) {
  const st = stateOf(engine);
  const current = monthKey(nowOf(engine));
  if (!validKey(key) || key < shiftMonth(current, -1)) return null;
  let doc = st.docs.get(sid);
  if (!doc) {
    doc = pruneMonths(engine.store.get(ID, sid, null), current);
    st.docs.set(sid, doc);
  } else if (!doc.months[key]) {
    doc = pruneMonths(doc, current);
    st.docs.set(sid, doc);
  }
  if (!doc.months[key]) doc.months[key] = blankMonth();
  scheduleFlush(engine, sid);
  return doc.months[key];
}

function userIn(month, uid) {
  let u = month.users[uid];
  if (u) return u;
  if (Object.keys(month.users).length >= MAX_USERS) return null;
  u = blankUser();
  month.users[uid] = u;
  return u;
}

export function readMonth(engine, sid, key) {
  const st = stateOf(engine);
  const doc = st.docs.get(sid) || engine.store.get(ID, sid, null);
  const current = monthKey(nowOf(engine));
  const pruned = pruneMonths(doc, current);
  const m = pruned.months[key];
  return m ? fillMonth(m) : null;
}

function eventTime(engine, raw) {
  const t = Date.parse(raw || '');
  const now = nowOf(engine);
  return Number.isFinite(t) && Math.abs(t - now) < 86_400_000 ? t : now;
}

const isKnownBot = (engine, uid) => !!uid && (uid === botId(engine) || stateOf(engine).bots.has(uid));

function noteBot(engine, uid) {
  if (uid && uid !== botId(engine)) remember(stateOf(engine).bots, uid, true, MAX_BOTS);
}

async function isBotUser(engine, sid, uid) {
  if (!uid) return false;
  if (isKnownBot(engine, uid)) return true;
  const m = await engine.perms.member(sid, uid).catch(() => null);
  if (m?.bot || m?.is_bot) { noteBot(engine, uid); return true; }
  return false;
}

async function onMessage(ctx, msg) {
  const { engine } = ctx;
  const sid = msg?.server_id;
  const uid = msg?.author_id || (typeof msg?.author === 'object' ? msg.author?.id : null);
  if (!sid || !uid || msg.dm || msg.is_dm) return;
  if (msg.author_bot || msg.author?.bot || msg.author?.is_bot) { noteBot(engine, uid); return; }
  if (msg.yaposLate || msg.command || !msg.channel_id || isKnownBot(engine, uid)) return;
  const at = eventTime(engine, msg.created_at);
  if (!(await isPublicChannel(engine, sid, msg.channel_id))) return;
  const month = working(engine, sid, monthKey(at));
  if (!month) return;
  const d = new Date(at);
  const hour = d.getUTCHours();
  month.msgs += 1;
  month.hours[hour] += 1;
  month.dow[d.getUTCDay()] += 1;
  bump(month.ch, msg.channel_id, 1, MAX_CHANNELS);
  const u = userIn(month, uid);
  if (!u) return;
  u.m += 1;
  bump(u.ch, msg.channel_id, 1, MAX_USER_CHANNELS);
  u.h[hour] = (u.h[hour] || 0) + 1;
  const day = d.getUTCDate();
  if (!u.d.includes(day)) u.d.push(day);
}

const emojiOf = (ev) => clip(String(ev?.emoji ?? '').trim(), 64);
const seenKey = (key, sid, ev, emoji) => [key, sid, ev.message_id, ev.user_id, emoji].join('|');

async function onReaction(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  const giver = ev?.user_id;
  if (!sid || !giver || !ev.message_id || !ev.channel_id || ev.yaposLate || ev.user_bot || isKnownBot(engine, giver)) return;
  const st = stateOf(engine);
  const emoji = emojiOf(ev);
  const key = monthKey(eventTime(engine, ev.created_at));
  const seen = seenKey(key, sid, ev, emoji);
  if (st.seen.has(seen)) return;
  if (!(await isPublicChannel(engine, sid, ev.channel_id))) return;
  if (await isBotUser(engine, sid, giver)) return;
  const author = ev.message_author_id;
  const authorIsBot = !!author && author !== giver && await isBotUser(engine, sid, author);
  if (st.seen.has(seen)) return;
  const month = working(engine, sid, key);
  if (!month) return;
  const rec = { emoji: !!emoji, giver: false, author: null, reacted: false };
  if (emoji) bump(month.emojis, emoji, 1, MAX_EMOJIS);
  const g = userIn(month, giver);
  if (g) {
    g.rg += 1;
    rec.giver = true;
    if (emoji) bump(g.e, emoji, 1, MAX_USER_EMOJIS);
  }
  remember(st.seen, seen, rec, MAX_SEEN);
  if (!author || author === giver || authorIsBot || isKnownBot(engine, author)) return;
  const r = userIn(month, author);
  if (r) { r.rr += 1; rec.author = author; }
  const cur = month.reacted[ev.message_id];
  if (cur) cur.n += 1;
  else {
    const ids = Object.keys(month.reacted);
    if (ids.length >= MAX_REACTED) {
      let low = ids[0];
      for (const k of ids) if (month.reacted[k].n < month.reacted[low].n) low = k;
      delete month.reacted[low];
    }
    month.reacted[ev.message_id] = { n: 1, c: ev.channel_id, a: author };
  }
  rec.reacted = true;
}

function onReactionRemove(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  const giver = ev?.user_id;
  if (!sid || !giver || !ev.message_id) return;
  const st = stateOf(engine);
  const emoji = emojiOf(ev);
  const current = monthKey(nowOf(engine));
  for (const key of [current, shiftMonth(current, -1), shiftMonth(current, 1)]) {
    const seen = seenKey(key, sid, ev, emoji);
    const rec = st.seen.get(seen);
    if (!rec) continue;
    st.seen.delete(seen);
    const month = working(engine, sid, key);
    if (!month) return;
    if (rec.emoji) unbump(month.emojis, emoji);
    const g = rec.giver ? month.users[giver] : null;
    if (g) {
      g.rg = Math.max(0, (Number(g.rg) || 0) - 1);
      if (rec.emoji && g.e) unbump(g.e, emoji);
    }
    const r = rec.author ? month.users[rec.author] : null;
    if (r) r.rr = Math.max(0, (Number(r.rr) || 0) - 1);
    const cur = rec.reacted ? month.reacted[ev.message_id] : null;
    if (cur) {
      cur.n = Math.max(0, (Number(cur.n) || 0) - 1);
      if (!cur.n) delete month.reacted[ev.message_id];
    }
    return;
  }
}

const voiceKey = (sid) => `${sid}.voice`;

function openSessions(engine, sid, now) {
  const raw = engine.store.get(ID, voiceKey(sid), null);
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [uid, s] of Object.entries(raw)) {
    if (!s || !Number.isFinite(s.at) || now - s.at > STALE_SESSION_MS || s.at > now + 60_000) continue;
    out[uid] = { c: s.c || null, at: s.at };
  }
  return out;
}

function saveSessions(engine, sid, open) {
  if (Object.keys(open).length) engine.store.set(ID, voiceKey(sid), open);
  else if (engine.store.has(ID, voiceKey(sid))) engine.store.delete(ID, voiceKey(sid));
}

function onVoiceJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  const uid = ev?.user_id;
  if (!sid || !uid || isKnownBot(engine, uid)) return;
  const now = nowOf(engine);
  const open = openSessions(engine, sid, now);
  if (open[uid]) open[uid].c = ev.channel_id || open[uid].c;
  else if (Object.keys(open).length < MAX_USERS) open[uid] = { c: ev.channel_id || null, at: now };
  saveSessions(engine, sid, open);
  return isBotUser(engine, sid, uid).then((bot) => {
    if (!bot) return;
    const later = openSessions(engine, sid, nowOf(engine));
    if (!later[uid]) return;
    delete later[uid];
    saveSessions(engine, sid, later);
  }).catch(() => {});
}

function onVoiceLeave(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  const uid = ev?.user_id;
  if (!sid || !uid || isKnownBot(engine, uid)) return;
  const now = nowOf(engine);
  const open = openSessions(engine, sid, now);
  const s = open[uid];
  if (!s) return;
  if (ev.channel_id && s.c && ev.channel_id !== s.c) return;
  delete open[uid];
  saveSessions(engine, sid, open);
  const secs = Math.min(SESSION_CAP_S, Math.max(0, Math.round((now - s.at) / 1000)));
  if (!secs) return;
  const month = working(engine, sid, monthKey(now));
  if (!month) return;
  month.vs += secs;
  const u = userIn(month, uid);
  if (u) u.vs += secs;
}

function starsFor(engine, sid, key) {
  const out = {};
  try {
    const posts = engine.store.get('starboard', `${sid}.posts`, null);
    if (!posts || typeof posts !== 'object') return out;
    for (const p of Object.values(posts)) {
      if (!p?.authorId || !Number.isFinite(p.at) || monthKey(p.at) !== key) continue;
      out[p.authorId] = (out[p.authorId] || 0) + 1;
    }
  } catch (e) {
    engine.log.debug('[wrapped] could not read the starboard', e?.message);
  }
  return out;
}

function topOf(map, n) {
  return Object.entries(map || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function longestStreak(days) {
  const sorted = [...new Set(days || [])].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function timeZoneOf(engine, uid) {
  try {
    const tz = engine.service('pocket')?.timeZone?.(uid);
    return tz && isTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

function localHour(utcHour, tz, key) {
  if (tz === 'UTC') return utcHour;
  const [y, m] = String(key).split('-').map(Number);
  try {
    return partsAt(Date.UTC(y, m - 1, 15, utcHour), tz).h;
  } catch {
    return utcHour;
  }
}

const voiceHours = (secs) => `${(Math.round((secs / 3600) * 10) / 10).toLocaleString('en-US')} h`;
const hourText = (h) => `${String(h).padStart(2, '0')}:00`;

function daysSoFar(engine, key) {
  const now = nowOf(engine);
  return monthKey(now) === key ? new Date(now).getUTCDate() : daysIn(key);
}

async function publicTop(engine, sid, entries, n) {
  const out = [];
  for (const e of entries) {
    if (out.length >= n) break;
    if (await isPublicChannel(engine, sid, e[0])) out.push(e);
  }
  return out;
}

function rankOf(engine, month, uid) {
  const list = Object.entries(month.users).filter(([id, u]) => u.m > 0 && !isKnownBot(engine, id)).sort((a, b) => b[1].m - a[1].m || a[0].localeCompare(b[0]));
  const i = list.findIndex(([id]) => id === uid);
  return { rank: i >= 0 ? i + 1 : null, of: list.length };
}

export function personality({ u, rank, localHist, daysSoFar: soFar }) {
  const msgs = u.m;
  const share = (from, to) => {
    let n = 0;
    for (let h = from; h < to; h++) n += localHist[h] || 0;
    return msgs ? n / msgs : 0;
  };
  if (msgs < 5 && u.vs < 600 && u.rg < 5) return { title: 'Lurker', icon: '👀', line: 'Quietly watching. Every server needs a good listener.' };
  if (rank && rank <= 3 && msgs >= 10) return { title: 'Chatterbox', icon: '💬', line: 'One of the loudest voices in the room. The chat would be quiet without you.' };
  if (msgs >= 10 && share(0, 5) >= 0.4) return { title: 'Night Owl', icon: '🦉', line: 'Most of your messages land after midnight. Sleep is optional.' };
  if (msgs >= 10 && share(5, 9) >= 0.4) return { title: 'Early Bird', icon: '🐦', line: 'You are up and chatting before most people find their coffee.' };
  if (u.rr >= 10 && u.rr >= msgs * 2) return { title: 'Hype Machine', icon: '🔥', line: 'People cannot stop reacting to what you say.' };
  if (u.rg >= 5 && u.rg > msgs) return { title: 'Reactor', icon: '🎯', line: 'You react more than you type. A true supporter.' };
  if (u.vs > 2 * 3600) return { title: 'Voice Regular', icon: '🎙️', line: 'You would rather talk than type. The voice rooms know you well.' };
  if (u.d.length >= 5 && u.d.length >= soFar * 0.6) return { title: 'Steady', icon: '📅', line: 'You show up almost every day. Reliable as a sunrise.' };
  return { title: 'Good Vibes', icon: '✨', line: 'A friendly face around here. Keep it up.' };
}

async function nameOf(engine, sid, uid) {
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return m?.nickname || m?.display_name || m?.username || 'Someone';
}

export async function personalCard(engine, sid, uid, key) {
  const month = readMonth(engine, sid, key);
  const name = await nameOf(engine, sid, uid);
  const title = `🎁 ${clip(name, 80)}'s Wrapped · ${monthLabel(key)}`;
  const u = month?.users?.[uid] ? { ...blankUser(), ...month.users[uid] } : null;
  if (!u || (!u.m && !u.vs && !u.rg && !u.rr)) {
    const isNow = monthKey(nowOf(engine)) === key;
    return card({ title, body: isNow ? 'Nothing to wrap yet. Chat, react or hop in voice, then check back.' : `No recap for ${monthLabel(key)}. I didn't see any activity that month.`, color: GREEN, footer: 'Yap Wrapped · counts only, never message text' });
  }
  const tz = timeZoneOf(engine, uid);
  const localHist = Array(24).fill(0);
  for (const [h, n] of Object.entries(u.h)) localHist[localHour(Number(h), tz, key)] += n;
  let topHour = null;
  for (let h = 0; h < 24; h++) if (localHist[h] > 0 && (topHour === null || localHist[h] > localHist[topHour])) topHour = h;
  const { rank, of } = rankOf(engine, month, uid);
  const soFar = daysSoFar(engine, key);
  const p = personality({ u, rank, localHist, daysSoFar: soFar });
  const [topChannel] = await publicTop(engine, sid, topOf(u.ch, Infinity), 1);
  const fav = topOf(u.e, 1)[0];
  const stars = starsFor(engine, sid, key)[uid] || 0;
  const streak = longestStreak(u.d);
  const fields = [
    { name: '💬 Messages', value: `**${num(u.m)}**${rank ? ` · #${num(rank)} of ${num(of)}` : ''}`, inline: true },
    { name: '📍 Top channel', value: topChannel ? `<#${topChannel[0]}> (${num(topChannel[1])})` : 'None yet', inline: true },
    { name: '⏰ Most active hour', value: topHour === null ? 'None yet' : `${hourText(topHour)} ${tz === 'UTC' ? 'UTC' : `(${tz})`}`, inline: true },
    { name: '📅 Active days', value: `**${num(u.d.length)}** of ${num(soFar)}${streak > 1 ? ` · best streak ${plural(streak, 'day')}` : ''}`, inline: true },
    { name: '💖 Reactions', value: `${num(u.rg)} given · ${num(u.rr)} received`, inline: true },
    { name: '🎙️ Voice time', value: u.vs ? formatDuration(u.vs * 1000) : 'None', inline: true },
    fav ? { name: '😍 Favourite reaction', value: `${fav[0]} × ${num(fav[1])}`, inline: true } : null,
    stars ? { name: '⭐ Starboard', value: `${plural(stars, 'post')} made it`, inline: true } : null,
  ];
  return card({ title, body: `## ${p.icon} ${p.title}\n${p.line}`, fields, color: GREEN, footer: 'Yap Wrapped · counts only, never message text' });
}

async function memberOfMonth(engine, sid, month, stars) {
  const ranked = [];
  for (const [id, raw] of Object.entries(month.users)) {
    const u = { ...blankUser(), ...raw };
    if (!(u.m > 0) || isKnownBot(engine, id)) continue;
    const score = u.m + u.rr * 2 + Math.floor(u.vs / 600) + (stars[id] || 0) * 5;
    if (score > 0) ranked.push({ id, score, u });
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const c of ranked.slice(0, MOM_TRIES)) {
    const m = await engine.perms.member(sid, c.id).catch(() => null);
    if (m?.bot || m?.is_bot) { noteBot(engine, c.id); continue; }
    return c;
  }
  return null;
}

async function mostReacted(engine, sid, month) {
  const list = Object.entries(month.reacted || {})
    .filter(([, v]) => v && v.n > 0 && v.c)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  for (const [id, v] of list) if (await isPublicChannel(engine, sid, v.c)) return { id, n: v.n, c: v.c };
  return null;
}

export async function serverCard(engine, sid, key, serverName) {
  const month = readMonth(engine, sid, key);
  const title = `🎁 ${serverName ? `${clip(serverName, 80)} ` : 'Server '}Wrapped · ${monthLabel(key)}`;
  const people = () => Object.entries(month?.users || {}).filter(([id]) => !isKnownBot(engine, id));
  const active = people().filter(([, u]) => u.m || u.vs || u.rg).length;
  if (!month || (!month.msgs && !month.vs && !active)) {
    return card({ title, body: `No recap for ${monthLabel(key)} yet. Once people chat, react and hang out in voice, it fills up here.`, color: GREEN, footer: 'Yap Wrapped' });
  }
  const stars = starsFor(engine, sid, key);
  const mom = await memberOfMonth(engine, sid, month, stars);
  const chatters = people().filter(([, u]) => u.m > 0).sort((a, b) => b[1].m - a[1].m || a[0].localeCompare(b[0])).slice(0, 5);
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  const chans = await publicTop(engine, sid, topOf(month.ch, Infinity), 3);
  let busyHour = null;
  for (let h = 0; h < 24; h++) if (month.hours[h] > 0 && (busyHour === null || month.hours[h] > month.hours[busyHour])) busyHour = h;
  let busyDay = null;
  for (let d = 0; d < 7; d++) if (month.dow[d] > 0 && (busyDay === null || month.dow[d] > month.dow[busyDay])) busyDay = d;
  const emojis = topOf(month.emojis, 5);
  const most = await mostReacted(engine, sid, month);
  const fields = [
    { name: '💬 Messages', value: `**${num(month.msgs)}**`, inline: true },
    { name: '👥 Active members', value: `**${num(active)}**`, inline: true },
    { name: '🎙️ Voice', value: month.vs ? voiceHours(month.vs) : 'None', inline: true },
    chatters.length ? { name: '🏆 Top chatters', value: chatters.map(([id, u], i) => `${medals[i]} <@${id}> · ${num(u.m)}`).join('\n'), inline: true } : null,
    chans.length ? { name: '📍 Top channels', value: chans.map(([id, n]) => `<#${id}> · ${num(n)}`).join('\n'), inline: true } : null,
    busyHour !== null ? { name: '⏰ Busiest time', value: `${hourText(busyHour)} UTC${busyDay !== null ? `\n${DAYS[busyDay]}s` : ''}`, inline: true } : null,
    emojis.length ? { name: '😍 Top reactions', value: emojis.map(([e, n]) => `${e} ${num(n)}`).join(' · '), inline: false } : null,
    most ? { name: '🔥 Most reacted message', value: `${plural(most.n, 'reaction')} · [jump to it](${messageLink(sid, most.c, most.id)})`, inline: true } : null,
    mom ? { name: '👑 Member of the month', value: `<@${mom.id}> · ${plural(mom.u.m, 'message')}${mom.u.rr ? `, ${plural(mom.u.rr, 'reaction')} received` : ''}`, inline: true } : null,
  ];
  return card({ title, body: 'Here is how the month went. Thanks for making this place fun.', fields, color: GREEN, footer: 'Yap Wrapped · counts only, never message text' });
}

async function serverName(engine, sid) {
  try {
    const s = await engine.perms.server(sid);
    return s?.name || null;
  } catch {
    return null;
  }
}

function toggleFor(engine, key) {
  const current = monthKey(nowOf(engine));
  return key === current ? { label: 'Last month', key: shiftMonth(current, -1), emoji: '⏪' } : { label: 'This month', key: current, emoji: '⏩' };
}

async function personalView(engine, sid, opener, target, key) {
  const t = toggleFor(engine, key);
  return {
    embeds: [await personalCard(engine, sid, target, key)],
    components: [row(
      button('Server Wrapped', cid('srv', key), 'primary', '🌐'),
      button(t.label, cid('me', opener, target, t.key), 'secondary', t.emoji),
      opener !== target ? button('My Wrapped', cid('mine', key), 'secondary', '🎁') : null,
    )],
  };
}

async function serverView(engine, sid, opener, key, { toggle = true } = {}) {
  const t = toggleFor(engine, key);
  return {
    embeds: [await serverCard(engine, sid, key, await serverName(engine, sid))],
    components: [row(
      button('My Wrapped', cid('mine', key), 'primary', '🎁'),
      toggle && opener ? button(t.label, cid('sm', opener, t.key), 'secondary', t.emoji) : null,
    )],
  };
}

function infoCard() {
  return card({
    title: '🎁 Yap Wrapped',
    body: [
      'Your month in numbers: messages, top channel, busiest hour, reactions, voice time and a personality.',
      '`/wrapped` your card · `/wrapped last` last month · `/wrapped @someone` · `/wrapped server` · `/wrapped server last`',
      'Admins: `/wrapped post #channel` posts last month\'s server card on the 1st at 12:00 UTC · `/wrapped post off`',
      '-# I only count. I never store what you write.',
    ].join('\n'),
    color: GREEN,
  });
}

async function postSettings(ctx, rest) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const arg = rest.join(' ').trim();
  if (!arg) {
    const ch = ctx.config().postChannelId;
    const job = engine.scheduler.list({ kind: POST_KIND, serverId: sid, key: POST_KEY })[0];
    const when = job ? `<t:${Math.floor(job.at / 1000)}:F>` : null;
    if (ch && !job) return ctx.info('Monthly Wrapped post', `It is off right now: the monthly post for <#${ch}> isn't scheduled.\nTurn it on again with \`/wrapped post #channel\`.`);
    return ctx.info('Monthly Wrapped post', ch ? `Last month's server Wrapped goes to <#${ch}> on the 1st at 12:00 UTC.${when ? `\nNext one: ${when}` : ''}\nTurn it off with \`/wrapped post off\`.` : 'It is off. Turn it on with `/wrapped post #channel`.');
  }
  if (['off', 'stop', 'disable', 'none'].includes(arg.toLowerCase())) {
    ctx.patchConfig({ postChannelId: null });
    engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: sid, key: POST_KEY });
    return ctx.ok('Monthly post is off', 'I won\'t post the server Wrapped anymore. Anyone can still run `/wrapped server`.');
  }
  const ch = await ctx.findChannel(arg);
  if (!ch) return ctx.warn("I couldn't find that channel", 'Mention it like `/wrapped post #general`, or type its name.');
  const can = await engine.perms.botCan(sid, 'send_messages', 'embed_links').catch(() => ({ ok: true }));
  let job = null;
  try {
    job = engine.scheduler.schedule({ kind: POST_KIND, serverId: sid, key: POST_KEY, data: { v: 1 }, repeat: { monthly: { day: 1, time: '12:00' }, tz: 'UTC' } });
  } catch (e) {
    engine.log.warn(`[wrapped] couldn't schedule the monthly post: ${e?.message}`);
  }
  if (!job || !Number.isFinite(job.at)) return ctx.warn("I couldn't schedule the monthly post", 'Nothing changed. Try `/wrapped post #channel` again in a minute.');
  ctx.patchConfig({ postChannelId: ch.id });
  const warn = can.ok === false ? `\n-# I may be missing **Send Messages** or **Embed Links**. Check my role can post in <#${ch.id}>.` : '';
  return ctx.ok('Monthly Wrapped is on', `On the 1st of every month at 12:00 UTC, I post last month's server Wrapped in <#${ch.id}>.\nFirst one: <t:${Math.floor(job.at / 1000)}:F>${warn}`);
}

async function runWrapped(ctx) {
  const { engine, serverId: sid } = ctx;
  if (!sid) return ctx.reply('Yap Wrapped works in servers. Run `/wrapped` in one.');
  const toks = tokenize(String(ctx.args ?? '').trim());
  const words = toks.map((t) => t.toLowerCase());
  const current = monthKey(nowOf(engine));
  if (words[0] === 'help' || words[0] === '?') return ctx.ephemeral({ embeds: [infoCard()] });
  if (words[0] === 'post' || words[0] === 'schedule' || words[0] === 'auto') return postSettings(ctx, toks.slice(1));
  let last = false;
  let server = false;
  const rest = [];
  for (let i = 0; i < toks.length; i++) {
    const w = words[i];
    if (LAST_WORDS.includes(w)) { last = true; if (words[i + 1] === 'month') i++; continue; }
    if (THIS_WORDS.includes(w)) continue;
    if (SERVER_WORDS.includes(w)) { server = true; continue; }
    if (['me', 'mine', 'my'].includes(w)) continue;
    rest.push(toks[i]);
  }
  const key = last ? shiftMonth(current, -1) : current;
  if (server) return ctx.reply({ ...(await serverView(engine, sid, ctx.userId, key)), open: true });
  let target = ctx.userId;
  if (rest.length) {
    const found = await ctx.findUser(rest.join(' '));
    if (!found?.id) {
      const hint = didYouMean(rest[0], ['last', 'server', 'post', 'help']);
      return ctx.warn("I couldn't find that member", `Try \`/wrapped @name\`, \`/wrapped last\` or \`/wrapped server\`.${hint?.length ? `\nDid you mean **${hint[0]}**?` : ''}`);
    }
    if (found.id === botId(engine)) return ctx.info('I am not wrapped', 'I only count everyone else. Try `/wrapped server`.');
    target = found.id;
  }
  return ctx.reply({ ...(await personalView(engine, sid, ctx.userId, target, key)), open: true });
}

async function postJob(job, engine) {
  const sid = job.serverId;
  if (!sid) return;
  if (!engine.settings.isEnabled(sid, ID)) return;
  const ch = engine.settings.appConfig(sid, ID).postChannelId;
  if (!ch) { engine.scheduler.cancel(job.id); return; }
  if (job.lateByMs > LATE_SKIP_MS) return;
  const key = shiftMonth(monthKey(job.at), -1);
  flush(engine, sid);
  const month = readMonth(engine, sid, key);
  if (!month || (!month.msgs && !month.vs && !Object.keys(month.users).length)) return;
  const view = await serverView(engine, sid, null, key, { toggle: false });
  try {
    await engine.budget.send({ serverId: sid, channelId: ch, content: `🎁 **${monthLabel(key)} Wrapped** is here!`, opts: view, priority: 'low', key: `wrapped:post:${sid}:${key}` });
  } catch (e) {
    engine.log.warn(`[wrapped] couldn't post the monthly Wrapped: ${e?.message}`);
  }
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Yap Wrapped',
  icon: '🎁',
  description: 'Monthly recap cards for you and the server: messages, channels, reactions, voice and a personality.',
  category: 'Community',
  panelPerm: 'member',

  defaults: {
    postChannelId: null,
  },

  dashboard: [
    { key: 'postChannelId', label: 'Monthly Wrapped post channel', type: 'channel', web: false, help: "Where last month's server Wrapped is posted on the 1st at 12:00 UTC.", note: 'Change it in the server with /wrapped post #channel, which schedules the monthly post.' },
  ],

  commands: {
    wrapped: { description: 'Your monthly recap. /wrapped last · /wrapped @user · /wrapped server · admins: /wrapped post #ch', run: runWrapped },
  },

  components: {
    srv: { run: async (ctx) => {
      const key = validKey(ctx.argv[0]) ? ctx.argv[0] : monthKey(nowOf(ctx.engine));
      return ctx.ephemeral({ embeds: [await serverCard(ctx.engine, ctx.serverId, key, await serverName(ctx.engine, ctx.serverId))] });
    } },
    mine: { run: async (ctx) => {
      const key = validKey(ctx.argv[0]) ? ctx.argv[0] : monthKey(nowOf(ctx.engine));
      return ctx.ephemeral({ embeds: [await personalCard(ctx.engine, ctx.serverId, ctx.userId, key)] });
    } },
    me: { run: async (ctx) => {
      const [opener, target, raw] = ctx.argv;
      const key = validKey(raw) ? raw : monthKey(nowOf(ctx.engine));
      if (ctx.userId === opener) return ctx.update(await personalView(ctx.engine, ctx.serverId, opener, target, key));
      return ctx.ephemeral({ embeds: [await personalCard(ctx.engine, ctx.serverId, target, key)] });
    } },
    sm: { run: async (ctx) => {
      const [opener, raw] = ctx.argv;
      const key = validKey(raw) ? raw : monthKey(nowOf(ctx.engine));
      if (ctx.userId === opener) return ctx.update(await serverView(ctx.engine, ctx.serverId, opener, key));
      return ctx.ephemeral({ embeds: [await serverCard(ctx.engine, ctx.serverId, key, await serverName(ctx.engine, ctx.serverId))] });
    } },
  },

  events: {
    message: onMessage,
    reaction_add: onReaction,
    reaction_remove: onReactionRemove,
    voice_join: onVoiceJoin,
    voice_leave: onVoiceLeave,
  },

  jobs: {
    post: postJob,
  },

  yap: [
    { words: ['wrapped', 'recap'], run: runWrapped },
  ],

  panel: async (ctx) => ctx.ephemeral(await personalView(ctx.engine, ctx.serverId, ctx.userId, ctx.userId, monthKey(nowOf(ctx.engine)))),

  help: [
    'Your month in numbers: `/wrapped` · last month: `/wrapped last` · someone else: `/wrapped @name` · the whole server: `/wrapped server`.',
    'Admins: `/wrapped post #channel` posts last month\'s server Wrapped on the 1st at 12:00 UTC. `/wrapped post off` stops it.',
    'Only counts are kept, never what anyone wrote. Each server keeps this month and last month.',
  ],

  init: (engine) => {
    const st = stateOf(engine);
    if (st.exitHook) engine.store.beforeExit?.delete?.(st.exitHook);
    st.exitHook = () => flushAll(engine);
    engine.store.beforeExit?.add?.(st.exitHook);
  },

  dispose: (engine) => {
    flushAll(engine);
    const st = states.get(engine);
    if (st) {
      for (const t of st.timers.values()) clearTimeout(t);
      if (st.exitHook) engine.store.beforeExit?.delete?.(st.exitHook);
    }
    states.delete(engine);
  },
});
