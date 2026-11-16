import { defineApp } from '../engine/apps.js';
import { card, button, row, onOff } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { clip, didYouMean } from '../engine/parse.js';
import { isPublicChannel } from '../engine/visibility.js';
import { ensureStats } from '../engine/stats.js';
import { partyMany } from '../engine/profile-data.js';

const ID = 'recap';
const ICON = '📰';
const COLOR = 0x5cc8ff;
const cid = (action, ...args) => customId(ID, action, ...args);

const POST_KIND = `${ID}.post`;
const POST_KEY = 'weekly';
const POST_TIME = '18:00';
const TICK_MS = 15 * 60_000;
const STATS_MS = 3600_000;
const LATE_SKIP_MS = 2 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;
const MAX_USERS = 5000;
const MAX_BASELINE = 300;
const BASELINE_PER_TICK = 50;
const TOP_ACTIVE = 5;
const TOP_LEVELS = 3;
const TOP_PARTY = 3;
const PARTY_CANDIDATES = 50;
const SAFE_ID = /^[\w-]{1,64}$/;
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OFF_WORDS = ['off', 'stop', 'disable', 'none'];

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { docs: new Map(), dirty: new Set(), exitHook: null, timers: [] };
    states.set(engine, s);
  }
  return s;
}

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${Math.round(Number(n) || 0) === 1 ? '' : 's'}`;
const validId = (v) => typeof v === 'string' && SAFE_ID.test(v);
const displayName = (m) => m?.nickname || m?.display_name || m?.username || 'Someone';
const safeName = (s) => clip(String(s ?? '').replace(/[*_`~|\\<>@#]/g, '').replace(/\s+/g, ' ').trim(), 40) || 'Someone';

export function parseDay(text) {
  let t = String(text || '').trim().toLowerCase();
  if (t.length > 6 && t.endsWith('days')) t = t.slice(0, -1);
  if (t.length < 3) return null;
  const i = DAYS.findIndex((d) => d.toLowerCase().startsWith(t));
  return i >= 0 ? i : null;
}

function blankDoc(t) {
  return { since: t, users: {}, joins: 0, messages: 0, party: {} };
}

function cleanDoc(raw, t) {
  const d = blankDoc(t);
  if (!raw || typeof raw !== 'object') return d;
  if (Number.isFinite(raw.since)) d.since = raw.since;
  d.joins = Number.isInteger(raw.joins) && raw.joins > 0 ? raw.joins : 0;
  d.messages = Number.isInteger(raw.messages) && raw.messages > 0 ? raw.messages : 0;
  if (raw.users && typeof raw.users === 'object') {
    for (const [uid, u] of Object.entries(raw.users)) {
      if (!validId(uid) || !u || typeof u !== 'object') continue;
      d.users[uid] = { n: Math.max(0, Math.floor(Number(u.n) || 0)), lv0: Number.isInteger(u.lv0) ? u.lv0 : null };
    }
  }
  if (raw.party && typeof raw.party === 'object') {
    for (const [uid, p] of Object.entries(raw.party)) {
      if (!validId(uid) || !p || typeof p !== 'object') continue;
      d.party[uid] = { games: Math.max(0, Math.floor(Number(p.games) || 0)), wins: Math.max(0, Math.floor(Number(p.wins) || 0)) };
    }
  }
  return d;
}

function docOf(engine, sid) {
  const st = stateOf(engine);
  let d = st.docs.get(sid);
  if (!d) {
    d = cleanDoc(engine.store.get(ID, sid, null), nowOf(engine));
    st.docs.set(sid, d);
  }
  return d;
}

function save(engine, sid) {
  const st = stateOf(engine);
  const d = st.docs.get(sid);
  if (d) engine.store.set(ID, sid, d);
  st.dirty.delete(sid);
}

function saveAll(engine) {
  const st = states.get(engine);
  if (!st) return;
  for (const sid of [...st.dirty]) save(engine, sid);
}

function levelNow(engine, uid) {
  const levels = engine.service('levels');
  if (!levels?.getUser) return null;
  try {
    const u = levels.getUser(null, uid);
    if (Number.isInteger(u?.level)) return u.level;
    return typeof levels.levelFor === 'function' ? levels.levelFor(u?.xp || 0) : null;
  } catch {
    return null;
  }
}

async function onMessage(ctx, msg) {
  const { engine } = ctx;
  const sid = msg?.server_id;
  const uid = msg?.author_id || (typeof msg?.author === 'object' ? msg.author?.id : null);
  if (!sid || !validId(uid) || msg.dm || msg.is_dm) return;
  if (msg.author_bot || msg.author?.bot || msg.author?.is_bot || uid === engine.bot.me?.id) return;
  if (!msg.channel_id || !(await isPublicChannel(engine, sid, msg.channel_id))) return;
  const d = docOf(engine, sid);
  let u = d.users[uid];
  if (!u) {
    if (Object.keys(d.users).length >= MAX_USERS) return;
    u = { n: 0, lv0: levelNow(engine, uid) };
    d.users[uid] = u;
  }
  u.n += 1;
  d.messages += 1;
  stateOf(engine).dirty.add(sid);
}

async function onJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  const uid = ev?.user_id ?? ev?.member?.id;
  if (!sid || uid === engine.bot.me?.id) return;
  docOf(engine, sid).joins += 1;
  stateOf(engine).dirty.add(sid);
}

export function topActive(users, limit = TOP_ACTIVE) {
  return Object.entries(users || {})
    .filter(([, u]) => u.n > 0)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, u]) => ({ id, n: u.n }));
}

export function topLevelUps(engine, users, limit = TOP_LEVELS) {
  const out = [];
  for (const [id, u] of Object.entries(users || {})) {
    if (!Number.isInteger(u.lv0)) continue;
    const now = levelNow(engine, id);
    if (!Number.isInteger(now) || now <= u.lv0) continue;
    out.push({ id, from: u.lv0, to: now, gain: now - u.lv0 });
  }
  return out.sort((a, b) => b.gain - a.gain || b.to - a.to || a.id.localeCompare(b.id)).slice(0, limit);
}

export function partyDeltas(baseline, current, limit = TOP_PARTY) {
  const out = [];
  for (const [id, now] of Object.entries(current || {})) {
    const was = baseline?.[id];
    if (!was || !now) continue;
    const games = Math.max(0, (now.games || 0) - (was.games || 0));
    const wins = Math.max(0, (now.wins || 0) - (was.wins || 0));
    if (!games) continue;
    out.push({ id, games, wins });
  }
  return out.sort((a, b) => b.wins - a.wins || b.games - a.games || a.id.localeCompare(b.id)).slice(0, limit);
}

function partyCandidates(d) {
  const ids = topActive(d.users, PARTY_CANDIDATES).map((u) => u.id);
  return ids;
}

function rememberParty(d, stats) {
  for (const [id, s] of Object.entries(stats || {})) {
    if (!validId(id) || !s) continue;
    delete d.party[id];
    d.party[id] = { games: s.games || 0, wins: s.wins || 0 };
  }
  const keys = Object.keys(d.party);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_BASELINE))) delete d.party[k];
}

async function serverName(engine, sid) {
  const s = await engine.perms.server(sid).catch(() => null);
  return s?.name ? safeName(s.name) : 'this server';
}

export async function buildRecap(engine, sid, { party = null } = {}) {
  const d = docOf(engine, sid);
  const members = await engine.cache.members(sid).catch(() => []);
  const byId = new Map(members.map((m) => [m.id, m]));
  const nameOf = (id) => (byId.has(id) ? safeName(displayName(byId.get(id))) : null);
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  const active = topActive(d.users, TOP_ACTIVE * 2).filter((u) => nameOf(u.id)).slice(0, TOP_ACTIVE);
  const ups = topLevelUps(engine, d.users, TOP_LEVELS * 2).filter((u) => nameOf(u.id)).slice(0, TOP_LEVELS);
  const players = party ? partyDeltas(d.party, party, TOP_PARTY * 2).filter((u) => nameOf(u.id)).slice(0, TOP_PARTY) : [];
  const stats = engine.serverStats?.totals?.(sid, d.since) || null;
  const leaves = stats ? stats.leaves : null;
  const fields = [
    { name: '💬 Messages', value: num(d.messages), inline: true },
    { name: '👋 New members', value: num(d.joins), inline: true },
    leaves !== null ? { name: '🚪 Left', value: num(leaves), inline: true } : null,
    active.length ? { name: '🔥 Most active', value: active.map((u, i) => `${medals[i]} **${nameOf(u.id)}** · ${plural(u.n, 'message')}`).join('\n'), inline: false } : null,
    ups.length ? { name: '📈 Top level-ups', value: ups.map((u) => `**${nameOf(u.id)}** · level ${num(u.from)} → **${num(u.to)}**`).join('\n'), inline: false } : null,
    players.length ? { name: '🎉 Top YapOS Party players', value: players.map((u) => `**${nameOf(u.id)}** · ${plural(u.wins, 'win')} in ${plural(u.games, 'game')}`).join('\n'), inline: false } : null,
  ];
  const quiet = !d.messages && !d.joins;
  const body = quiet
    ? 'A quiet week. Say hi in chat and you might top next week\'s list!'
    : `Here's how the week went since <t:${Math.floor(d.since / 1000)}:D>. Only counts are kept, never what anyone wrote.`;
  return {
    quiet,
    embed: card({ title: `${ICON} Weekly recap · ${await serverName(engine, sid)}`, body, fields, color: COLOR, footer: 'Weekly recap · /recap to change it' }),
  };
}

async function partyNow(engine, d) {
  if (!engine.dashboard?.enabled) return null;
  const ids = [...new Set([...partyCandidates(d), ...Object.keys(d.party)])].slice(0, PARTY_CANDIDATES);
  if (!ids.length) return null;
  const got = await partyMany(engine, ids).catch(() => null);
  if (!got) return null;
  const out = {};
  for (const [id, s] of Object.entries(got)) if (s) out[id] = s;
  return out;
}

async function postJob(job, engine) {
  const sid = job.serverId;
  if (!sid) return;
  const ch = engine.settings.appConfig(sid, ID).channelId;
  if (!engine.settings.isEnabled(sid, ID) || !ch) {
    engine.scheduler.cancel(job.id);
    return;
  }
  if (job.lateByMs > LATE_SKIP_MS) return;
  const d = docOf(engine, sid);
  const party = await partyNow(engine, d);
  const recap = await buildRecap(engine, sid, { party });
  if (!recap.quiet) {
    try {
      await engine.budget.send({ serverId: sid, channelId: ch, content: '', opts: { embeds: [recap.embed] }, priority: 'low', key: `recap:${sid}:${Math.floor(nowOf(engine) / WEEK_MS)}` });
    } catch (e) {
      engine.log.warn(`[recap] couldn't post the weekly recap: ${e?.message}`);
    }
  }
  const fresh = blankDoc(nowOf(engine));
  fresh.party = { ...d.party };
  if (party) rememberParty(fresh, party);
  stateOf(engine).docs.set(sid, fresh);
  save(engine, sid);
}

export async function recapTick(engine) {
  saveAll(engine);
  if (!engine.dashboard?.enabled) return;
  const st = stateOf(engine);
  let left = BASELINE_PER_TICK;
  for (const [sid, d] of st.docs) {
    if (left <= 0) break;
    const ch = engine.settings.appConfig(sid, ID).channelId;
    if (!ch) continue;
    const need = partyCandidates(d).filter((id) => !d.party[id]).slice(0, left);
    if (!need.length) continue;
    left -= need.length;
    const got = await partyMany(engine, need).catch(() => null);
    if (!got) continue;
    rememberParty(d, Object.fromEntries(Object.entries(got).filter(([, s]) => s)));
    st.dirty.add(sid);
  }
  saveAll(engine);
}

function startTimers(engine) {
  const st = stateOf(engine);
  for (const t of st.timers.splice(0)) clearInterval(t);
  const tick = setInterval(() => { recapTick(engine).catch((e) => engine.log.debug('[recap] upkeep failed', e?.message)); }, TICK_MS);
  const stats = setInterval(() => { engine.serverStats?.flush?.().catch((e) => engine.log.debug('[recap] stats upload failed', e?.message)); }, STATS_MS);
  for (const t of [tick, stats]) {
    t.unref?.();
    st.timers.push(t);
  }
}

function jobOf(engine, sid) {
  return engine.scheduler.list({ kind: POST_KIND, serverId: sid, key: POST_KEY })[0] || null;
}

function statusView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  const job = jobOf(engine, sid);
  const on = !!(cfg.channelId && job);
  const day = DAYS[Number.isInteger(cfg.day) ? cfg.day : 0];
  const lines = [
    `**Status:** ${onOff(on)}`,
    cfg.channelId ? `**Channel:** <#${cfg.channelId}>` : '**Channel:** not picked yet',
    `**Day:** ${day}s at ${POST_TIME} UTC`,
    on ? `**Next post:** <t:${Math.floor(job.at / 1000)}:F>` : null,
    '',
    'Each week I post the most active members, top level-ups, top YapOS Party players and how many people joined. Only counts, never what anyone wrote.',
    '',
    '`/recap #channel friday` · turn it on',
    '`/recap day monday` · change the day',
    '`/recap off` · turn it off',
  ].filter((l) => l !== null);
  return {
    embeds: [card({ title: `${ICON} Weekly recap`, body: lines.join('\n'), color: COLOR })],
    components: [row(
      button('Preview', cid('preview'), 'primary', '👀'),
      on ? button('Turn off', cid('off'), 'danger', '⏹️') : null,
    )],
  };
}

function schedulePost(engine, sid, day) {
  engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: sid, key: POST_KEY });
  return engine.scheduler.schedule({ kind: POST_KIND, serverId: sid, key: POST_KEY, data: { v: 1 }, repeat: { weekly: { days: [day], time: POST_TIME }, tz: 'UTC' } });
}

async function turnOn(ctx, channel, day) {
  const { engine, serverId: sid } = ctx;
  const can = await engine.perms.botCan(sid, 'send_messages', 'embed_links').catch(() => ({ ok: true }));
  let job = null;
  try {
    job = schedulePost(engine, sid, day);
  } catch (e) {
    engine.log.warn(`[recap] couldn't schedule the weekly post: ${e?.message}`);
  }
  if (!job || !Number.isFinite(job.at)) return ctx.warn("I couldn't schedule the weekly recap", 'Nothing changed. Try again in a minute.');
  ctx.patchConfig({ channelId: channel, day });
  const warn = can.ok === false ? `\n-# I may be missing **Send Messages** or **Embed Links**. Check my role can post in <#${channel}>.` : '';
  return ctx.ok('Weekly recap is on', `Every ${DAYS[day]} at ${POST_TIME} UTC I'll post the week's recap in <#${channel}>.\nFirst one: <t:${Math.floor(job.at / 1000)}:F>${warn}`);
}

async function turnOff(ctx) {
  ctx.engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: ctx.serverId, key: POST_KEY });
  ctx.patchConfig({ channelId: null });
  return ctx.ok('Weekly recap is off', "I won't post it anymore. Turn it back on with `/recap #channel`.");
}

async function preview(ctx) {
  const d = docOf(ctx.engine, ctx.serverId);
  const party = await partyNow(ctx.engine, d).catch(() => null);
  const recap = await buildRecap(ctx.engine, ctx.serverId, { party });
  return ctx.ephemeral({ content: '-# Preview: this is what the recap would look like right now.', embeds: [recap.embed] });
}

async function runRecap(ctx) {
  await ctx.require('admin');
  const toks = ctx.argv.map(String);
  const words = toks.map((w) => w.toLowerCase());
  if (!words.length) return ctx.ephemeral(statusView(ctx));
  if (words[0] === 'help' || words[0] === '?' || words[0] === 'status') return ctx.ephemeral(statusView(ctx));
  if (OFF_WORDS.includes(words[0])) return turnOff(ctx);
  if (words[0] === 'preview' || words[0] === 'test') return preview(ctx);
  const cfg = ctx.config();
  if (words[0] === 'day') {
    const day = parseDay(words[1]);
    if (day === null) return ctx.warn("I didn't catch the day", 'Try `/recap day friday`.');
    if (!cfg.channelId) {
      ctx.patchConfig({ day });
      return ctx.ok('Day saved', `The recap will post on ${DAYS[day]}s once you pick a channel: \`/recap #channel\`.`);
    }
    return turnOn(ctx, cfg.channelId, day);
  }
  let day = Number.isInteger(cfg.day) ? cfg.day : 0;
  const last = parseDay(words[words.length - 1]);
  let chanToks = toks;
  if (last !== null && toks.length > 1) {
    day = last;
    chanToks = toks.slice(0, -1);
  }
  const ch = await ctx.findChannel(chanToks.join(' '));
  if (!ch) {
    const hint = didYouMean(words[0], ['off', 'preview', 'day']);
    return ctx.warn("I couldn't find that channel", `Mention it like \`/recap #general friday\`.${hint?.length ? `\nDid you mean **${hint[0]}**?` : ''}`);
  }
  return turnOn(ctx, ch.id, day);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Weekly Recap',
  icon: ICON,
  description: 'A weekly post with the most active members, level-ups, Party stars and new members.',
  category: 'Community',
  phase: 2,
  panelPerm: 'admin',

  defaults: {
    channelId: null,
    day: 0,
  },

  dashboard: [
    { key: 'channelId', label: 'Weekly recap channel', type: 'channel', web: false, help: "Where the weekly recap is posted. It's off until a channel is picked.", note: 'Change it in the server with /recap #channel, which schedules the weekly post.' },
  ],

  commands: {
    recap: { description: 'Admins: a weekly server recap post. /recap #channel friday · /recap off · /recap preview', run: runRecap },
  },

  components: {
    preview: { perm: 'admin', run: preview },
    off: { perm: 'admin', run: turnOff },
  },

  events: {
    message: onMessage,
    member_join: onJoin,
  },

  jobs: {
    post: postJob,
  },

  yap: [{ words: ['recap', 'weekly', 'weeklyrecap'], run: runRecap }],

  panel: async (ctx) => {
    await ctx.require('admin');
    return ctx.ephemeral(statusView(ctx));
  },

  help: [
    'Admins: `/recap #channel friday` posts a recap every week at 18:00 UTC. `/recap off` stops it, `/recap preview` shows it now.',
    'The recap shows the most active members, top level-ups, top YapOS Party players and how many people joined.',
    'Only counts are kept, never what anyone wrote. Private channels are not counted.',
  ],

  init(engine) {
    ensureStats(engine);
    startTimers(engine);
    const st = stateOf(engine);
    if (st.exitHook) engine.store.beforeExit?.delete?.(st.exitHook);
    st.exitHook = () => saveAll(engine);
    engine.store.beforeExit?.add?.(st.exitHook);
  },

  dispose(engine) {
    saveAll(engine);
    const st = states.get(engine);
    if (st?.exitHook) engine.store.beforeExit?.delete?.(st.exitHook);
    for (const t of st?.timers || []) clearInterval(t);
    try { engine.serverStats?.save?.(); } catch (e) { engine.log.debug('[recap] saving stats failed', e?.message); }
    states.delete(engine);
  },
});
