import { defineApp } from '../engine/apps.js';
import { card, button, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, parseBool } from '../engine/parse.js';
import { GLOBAL_KEY, CURRENCY, globalConfig, patchGlobalConfig, canGiveCurrency } from '../engine/global.js';

const ID = 'achievements';
const cid = (action, ...args) => customId(ID, action, ...args);

const NS = 'achievements';
const SCAN_NS = 'achievescan';
const COLOR = 0xf5a623;
const SAFE_ID = /^[\w-]{1,64}$/;
const REWARD_MAX = 100_000;
const SCAN_EVERY_MS = 10 * 60_000;
const SCAN_TRACK = 2000;
const PAGE = 9;

export const ACHIEVEMENTS = Object.freeze([
  { id: 'msgs1k', icon: '💬', name: 'Chatterbox', desc: 'Send 1,000 messages', stat: 'messages', goal: 1000, reward: 100 },
  { id: 'msgs10k', icon: '📣', name: 'Town crier', desc: 'Send 10,000 messages', stat: 'messages', goal: 10000, reward: 500 },
  { id: 'level10', icon: '📈', name: 'Rising star', desc: 'Reach level 10', stat: 'level', goal: 10, reward: 100 },
  { id: 'level25', icon: '🌟', name: 'Regular', desc: 'Reach level 25', stat: 'level', goal: 25, reward: 250 },
  { id: 'level50', icon: '👑', name: 'Legend', desc: 'Reach level 50', stat: 'level', goal: 50, reward: 500 },
  { id: 'streak7', icon: '🔥', name: 'On a roll', desc: 'Reach a 7-day /daily streak', stat: 'streak', goal: 7, reward: 50 },
  { id: 'streak30', icon: '☄️', name: 'Devoted', desc: 'Reach a 30-day /daily streak', stat: 'streak', goal: 30, reward: 200 },
  { id: 'streak100', icon: '🌋', name: 'Unstoppable', desc: 'Reach a 100-day /daily streak', stat: 'streak', goal: 100, reward: 750 },
  { id: 'casino50', icon: '🎰', name: 'High roller', desc: 'Win 50 casino games', stat: 'casino', goal: 50, reward: 150 },
  { id: 'party10', icon: '🎉', name: 'Party starter', desc: 'Play 10 YapOS Party games', stat: 'party', goal: 10, reward: 50 },
  { id: 'party100', icon: '🥳', name: 'Party animal', desc: 'Play 100 YapOS Party games', stat: 'party', goal: 100, reward: 300 },
  { id: 'partywin25', icon: '🏆', name: 'Party champion', desc: 'Win 25 YapOS Party games', stat: 'partyWins', goal: 25, reward: 200 },
  { id: 'quests10', icon: '📜', name: 'Errand runner', desc: 'Complete 10 daily quests', stat: 'quests', goal: 10, reward: 50 },
  { id: 'quests50', icon: '🗺️', name: 'Quest master', desc: 'Complete 50 daily quests', stat: 'quests', goal: 50, reward: 250 },
  { id: 'tickets100', icon: '🎫', name: 'Frequent flyer', desc: 'Open 100 tickets', stat: 'tickets', goal: 100, reward: 100 },
  { id: 'clanfound', icon: '🛡️', name: 'Founder', desc: 'Found a clan', stat: 'founded', goal: 1, reward: 50 },
  { id: 'clanjoin', icon: '🤝', name: 'Better together', desc: 'Join a clan someone else started', stat: 'joined', goal: 1, reward: 25 },
]);
const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
const COUNTED = new Set(['casino', 'party', 'partyWins', 'quests', 'tickets', 'founded', 'joined']);

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const fmt = (n) => Math.max(0, Math.trunc(Number(n) || 0)).toLocaleString('en-US');
const validId = (v) => typeof v === 'string' && SAFE_ID.test(v);
const cfgOf = (engine) => globalConfig(engine, ID);

const blankUser = () => ({ got: {}, n: {}, unseen: [], dm: true });

function fixUser(d) {
  const u = d && typeof d === 'object' ? d : blankUser();
  if (!u.got || typeof u.got !== 'object' || Array.isArray(u.got)) u.got = {};
  if (!u.n || typeof u.n !== 'object' || Array.isArray(u.n)) u.n = {};
  if (!Array.isArray(u.unseen)) u.unseen = [];
  if (typeof u.dm !== 'boolean') u.dm = true;
  return u;
}

const readUser = (engine, uid) => fixUser(engine.store.get(NS, uid, null));

function mutateUser(engine, uid, fn) {
  let out;
  engine.store.update(NS, uid, (d) => {
    const u = fixUser(d);
    out = fn(u);
    return u;
  }, null);
  return out;
}

export function rewardOf(engine, id) {
  const def = BY_ID.get(id);
  if (!def) return 0;
  const cfg = cfgOf(engine);
  if (cfg.paying === false) return 0;
  const custom = cfg.rewards && typeof cfg.rewards === 'object' ? Number(cfg.rewards[id]) : NaN;
  return Number.isInteger(custom) && custom >= 0 && custom <= REWARD_MAX ? custom : def.reward;
}

function liveStats(engine, uid) {
  const out = {};
  try {
    const u = engine.service('levels')?.getUser?.(null, uid);
    if (u) {
      out.messages = Math.max(0, Math.floor(Number(u.messages) || 0));
      out.level = Math.max(0, Math.floor(Number(u.level) || 0));
    }
  } catch (e) {
    engine.log.debug('[achievements] reading levels failed', e?.message);
  }
  try {
    const s = engine.service('economy')?.streak?.(uid);
    if (Number.isFinite(Number(s))) out.streak = Math.max(0, Math.floor(Number(s)));
  } catch (e) {
    engine.log.debug('[achievements] reading the streak failed', e?.message);
  }
  return out;
}

export function statsOf(engine, uid, extra = {}) {
  const u = readUser(engine, uid);
  const live = liveStats(engine, uid);
  const out = {};
  for (const k of COUNTED) out[k] = Math.max(0, Math.floor(Number(u.n[k]) || 0));
  for (const k of ['messages', 'level', 'streak']) out[k] = Math.max(Number(live[k]) || 0, Number(extra[k]) || 0, Math.floor(Number(u.n[`best_${k}`]) || 0));
  return out;
}

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { scanned: new Map(), running: new Set() };
    states.set(engine, s);
  }
  return s;
}

async function notify(engine, uid, ids) {
  if (!ids.length || readUser(engine, uid).dm === false) return;
  const lines = ids.map((id) => {
    const a = BY_ID.get(id);
    const r = rewardOf(engine, id);
    return `${a.icon} **${a.name}** · ${a.desc}${r ? ` · +${fmt(r)} ${CURRENCY.emoji}` : ''}`;
  });
  const title = ids.length === 1 ? '🏅 Achievement unlocked!' : `🏅 ${ids.length} achievements unlocked!`;
  const body = `${lines.join('\n')}\n\n-# See them all with /achievements. Turn these messages off with \`/achievements dm off\`.`;
  try {
    const dm = await engine.bot.dm(uid);
    if (!dm) return;
    await engine.budget.send({ serverId: null, channelId: dm, opts: { embeds: [card({ title, body, color: COLOR, footer: false })] }, priority: 'low', key: `achievements:${uid}` });
  } catch (e) {
    engine.log.debug('[achievements] unlock DM failed', e?.message);
  }
}

export async function evaluate(engine, uid, extra = {}) {
  if (!validId(uid) || uid === engine.bot.me?.id) return [];
  const st = stateOf(engine);
  if (st.running.has(uid)) return [];
  st.running.add(uid);
  try {
    const stats = statsOf(engine, uid, extra);
    const have = readUser(engine, uid).got;
    const due = ACHIEVEMENTS.filter((a) => !have[a.id] && (stats[a.stat] || 0) >= a.goal).map((a) => a.id);
    const t = nowOf(engine);
    const fresh = due.length ? mutateUser(engine, uid, (u) => {
      const got = [];
      for (const id of due) {
        if (u.got[id]) continue;
        u.got[id] = t;
        u.unseen = [...u.unseen.filter((x) => x !== id), id].slice(-ACHIEVEMENTS.length);
        got.push(id);
      }
      for (const k of ['messages', 'level', 'streak']) {
        const v = Math.floor(Number(extra[k]) || 0);
        if (v > (Number(u.n[`best_${k}`]) || 0)) u.n[`best_${k}`] = v;
      }
      return got;
    }) : [];
    if (!fresh.length) {
      if (Number(extra.streak) > (Number(readUser(engine, uid).n.best_streak) || 0)) mutateUser(engine, uid, (u) => { u.n.best_streak = Math.floor(Number(extra.streak)); });
      return [];
    }
    const eco = engine.service('economy');
    for (const id of fresh) {
      const reward = rewardOf(engine, id);
      if (!reward || !eco || typeof eco.add !== 'function') continue;
      try {
        await eco.add(GLOBAL_KEY, uid, reward, `Achievement: ${BY_ID.get(id).name}`);
      } catch (e) {
        engine.log.warn(`[achievements] couldn't pay an achievement reward: ${e?.message}`);
      }
    }
    for (const id of fresh) {
      try {
        await engine.bot.emit?.('achievement:unlocked', { user: uid, server_id: null, id });
      } catch (e) {
        engine.log.debug('[achievements] achievement:unlocked listener failed', e?.message);
      }
    }
    await notify(engine, uid, fresh);
    return fresh;
  } finally {
    st.running.delete(uid);
  }
}

export function bump(engine, uid, stat, by = 1) {
  if (!validId(uid) || uid === engine.bot.me?.id || !COUNTED.has(stat)) return 0;
  const n = Math.max(0, Math.floor(Number(by) || 0));
  if (!n) return 0;
  return mutateUser(engine, uid, (u) => {
    u.n[stat] = Math.min(Number.MAX_SAFE_INTEGER, (Number(u.n[stat]) || 0) + n);
    return u.n[stat];
  });
}

export function scanTickets(engine, sid) {
  if (!validId(sid) || sid === GLOBAL_KEY) return [];
  const data = engine.store.get('tickets', sid, null);
  const list = data && data.tickets && typeof data.tickets === 'object' ? Object.values(data.tickets) : [];
  if (!list.length) return [];
  const cursor = Math.max(0, Math.floor(Number(engine.store.get(SCAN_NS, sid, null)?.n) || 0));
  const fresh = list.filter((t) => t && Number.isInteger(t.number) && t.number > cursor && validId(t.openerId));
  if (!fresh.length) return [];
  const counts = new Map();
  let top = cursor;
  for (const t of fresh) {
    counts.set(t.openerId, (counts.get(t.openerId) || 0) + 1);
    top = Math.max(top, t.number);
  }
  engine.store.set(SCAN_NS, sid, { n: top });
  for (const [uid, n] of counts) bump(engine, uid, 'tickets', n);
  return [...counts.keys()];
}

async function maybeScan(engine, sid, force = false) {
  if (!sid || !engine.apps?.has?.('tickets')) return;
  const st = stateOf(engine);
  const t = nowOf(engine);
  const last = st.scanned.get(sid);
  if (!force && last !== undefined && t - last < SCAN_EVERY_MS) return;
  st.scanned.delete(sid);
  st.scanned.set(sid, t);
  while (st.scanned.size > SCAN_TRACK) st.scanned.delete(st.scanned.keys().next().value);
  let openers = [];
  try {
    openers = scanTickets(engine, sid);
  } catch (e) {
    engine.log.debug('[achievements] ticket scan failed', e?.message);
  }
  for (const uid of openers) await evaluate(engine, uid);
}

function progressText(a, stats) {
  const have = Math.min(a.goal, stats[a.stat] || 0);
  return `${fmt(have)}/${fmt(a.goal)}`;
}

export function achievementsView(engine, uid, page = 0, viewer = uid) {
  const u = readUser(engine, uid);
  const stats = statsOf(engine, uid);
  const done = ACHIEVEMENTS.filter((a) => u.got[a.id]);
  const pages = Math.max(1, Math.ceil(ACHIEVEMENTS.length / PAGE));
  const p = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
  const unseen = new Set(u.unseen);
  const lines = ACHIEVEMENTS.slice(p * PAGE, p * PAGE + PAGE).map((a) => {
    const r = rewardOf(engine, a.id);
    const got = u.got[a.id];
    const mark = got ? '✅' : '▫️';
    const tail = got ? `${unseen.has(a.id) && viewer === uid ? '**new!** ' : ''}unlocked ${new Date(got).toISOString().slice(0, 10)}` : progressText(a, stats);
    return `${mark} ${a.icon} **${a.name}** · ${a.desc}${r ? ` · ${fmt(r)} ${CURRENCY.emoji}` : ''}\n-# ${tail}`;
  });
  const self = viewer === uid;
  const intro = self ? `Unlock these anywhere YapOS is. Each one pays a one-time ${CURRENCY.name} reward.` : `<@${uid}>'s achievements.`;
  const body = [intro, '', ...lines].join('\n');
  const btns = [];
  if (pages > 1) {
    btns.push(button('Back', cid('page', viewer, uid, String(p - 1)), 'secondary', '◀️', { disabled: p === 0 }));
    btns.push(button('Next', cid('page', viewer, uid, String(p + 1)), 'secondary', '▶️', { disabled: p >= pages - 1 }));
  }
  if (self) btns.push(button(u.dm ? 'Unlock DMs: on' : 'Unlock DMs: off', cid('dm', viewer), u.dm ? 'success' : 'secondary', '✉️'));
  return {
    embeds: [card({ title: `🏅 Achievements · ${done.length}/${ACHIEVEMENTS.length}`, body, color: COLOR, footer: `Page ${p + 1} of ${pages} · the same on every server` })],
    components: btns.length ? [row(btns)] : [],
  };
}

function markSeen(engine, uid) {
  if (!readUser(engine, uid).unseen.length) return;
  mutateUser(engine, uid, (u) => { u.unseen = []; });
}

async function showAchievements(ctx, query) {
  const { engine } = ctx;
  await maybeScan(engine, ctx.serverId, true);
  let target = ctx.userId;
  const q = String(query ?? '').trim();
  if (q && !/^me$/i.test(q) && ctx.serverId) {
    const found = await ctx.findUser(q).catch(() => null);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(q.replace(/[<>@*_`~|]/g, ''), 40) || 'that'}**. Try a mention, like \`/achievements @sam\`.`);
    target = found.id;
  }
  if (target === ctx.userId) await evaluate(engine, target);
  const view = achievementsView(engine, target, 0, ctx.userId);
  if (target === ctx.userId) markSeen(engine, target);
  return ctx.panel(view);
}

async function setDm(ctx, on) {
  const value = on === null ? !readUser(ctx.engine, ctx.userId).dm : on;
  mutateUser(ctx.engine, ctx.userId, (u) => { u.dm = value; });
  return ctx.ok('Saved', value ? "I'll DM you when you unlock an achievement." : "I won't DM you about achievements. You can still see them with /achievements.");
}

async function ownerReward(ctx, rest) {
  const { engine } = ctx;
  if (!canGiveCurrency(engine, ctx.userId)) return ctx.warn('Owner only', `Only the bot owner can change achievement rewards.`);
  const first = String(rest[0] ?? '').trim().toLowerCase();
  if (!first) {
    const lines = ACHIEVEMENTS.map((a) => `\`${a.id}\` ${a.name} · ${fmt(rewardOf(engine, a.id))} ${CURRENCY.emoji}`);
    return ctx.info('Achievement rewards', `${cfgOf(engine).paying === false ? 'Rewards are **off**.' : 'Rewards are **on**.'}\n${lines.join('\n')}\n-# Change one with \`/achievements reward msgs10k 300\`, or all with \`/achievements reward off\`.`);
  }
  const flag = parseBool(first);
  if (flag !== null && rest.length === 1) {
    patchGlobalConfig(engine, ID, { paying: flag });
    return ctx.ok('Saved', flag ? `Achievements pay their ${CURRENCY.name} rewards again.` : `Achievements still unlock, but pay no ${CURRENCY.name} for now.`);
  }
  const def = BY_ID.get(first);
  if (!def) {
    const guess = didYouMean(first, ACHIEVEMENTS.map((a) => a.id));
    return ctx.warn('Which achievement?', `I don't know **${clip(first, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `\`${g}\``).join(', ')}?` : ''}`);
  }
  const n = Number(String(rest[1] ?? '').trim());
  if (!Number.isInteger(n) || n < 0 || n > REWARD_MAX) return ctx.warn("That amount didn't work", `Use a whole number of ${CURRENCY.name} from 0 to ${fmt(REWARD_MAX)}.`);
  const cfg = cfgOf(engine);
  const rewards = { ...(cfg.rewards && typeof cfg.rewards === 'object' ? cfg.rewards : {}), [def.id]: n };
  patchGlobalConfig(engine, ID, { rewards });
  return ctx.ok('Saved', `**${def.name}** pays ${fmt(n)} ${CURRENCY.emoji} now. People who already have it keep what they got.`);
}

async function runAchievements(ctx) {
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (sub === 'dm' || sub === 'dms') return setDm(ctx, rest.length ? parseBool(rest[0]) : null);
  if (sub === 'reward' || sub === 'rewards') return ownerReward(ctx, rest);
  return showAchievements(ctx, tokens.join(' '));
}

function onXp(ctx, ev) {
  const uid = ev?.user;
  if (!validId(uid)) return undefined;
  if (!(Number(ev.amount) > 0) && !(Number(ev.messages) > 0)) return undefined;
  return evaluate(ctx.engine, uid);
}

function onShards(ctx, ev) {
  const uid = ev?.user;
  const source = String(ev?.source || '');
  if (!validId(uid) || !(Number(ev?.amount) > 0)) return undefined;
  if (source === 'casino') bump(ctx.engine, uid, 'casino');
  else if (source === 'quest') bump(ctx.engine, uid, 'quests');
  else return undefined;
  return evaluate(ctx.engine, uid);
}

function onDaily(ctx, ev) {
  if (!validId(ev?.user)) return undefined;
  return evaluate(ctx.engine, ev.user, { streak: Math.floor(Number(ev.streak) || 0) });
}

function onParty(ctx, ev) {
  if (!validId(ev?.user)) return undefined;
  bump(ctx.engine, ev.user, 'party');
  if (ev.won === true) bump(ctx.engine, ev.user, 'partyWins');
  return evaluate(ctx.engine, ev.user);
}

function onClan(stat) {
  return (ctx, ev) => {
    if (!validId(ev?.user)) return undefined;
    const u = readUser(ctx.engine, ev.user);
    if (!(Number(u.n[stat]) > 0)) bump(ctx.engine, ev.user, stat);
    return evaluate(ctx.engine, ev.user);
  };
}

function onMessage(ctx, msg) {
  if (!msg?.server_id || msg.author_bot) return undefined;
  return maybeScan(ctx.engine, msg.server_id);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Achievements',
  icon: '🏅',
  description: `Bot-wide achievements like "Send 10,000 messages" that pay a one-time ${CURRENCY.name} reward.`,
  category: 'Fun',
  panelPerm: 'member',

  defaults: { paying: true, rewards: {} },

  commands: {
    achievements: { description: `Your achievements and their ${CURRENCY.name} rewards: /achievements, /achievements @sam, /achievements dm off`, serverOnly: false, run: runAchievements },
  },

  components: {
    page: {
      owner: true,
      ownerArg: 0,
      run: async (ctx) => ctx.update(achievementsView(ctx.engine, ctx.argv[1], ctx.argv[2], ctx.userId)),
    },
    dm: {
      owner: true,
      ownerArg: 0,
      run: async (ctx) => {
        mutateUser(ctx.engine, ctx.userId, (u) => { u.dm = !u.dm; });
        return ctx.update(achievementsView(ctx.engine, ctx.userId, 0, ctx.userId));
      },
    },
  },

  events: {
    message: onMessage,
    'xp:gained': onXp,
    'shards:earned': onShards,
    'economy:daily': onDaily,
    'party:played': onParty,
    'clan:founded': onClan('founded'),
    'clan:joined': onClan('joined'),
  },

  yap: [
    { words: ['achievements', 'achievement', 'badges', 'trophies'], run: runAchievements },
  ],

  panel: async (ctx) => showAchievements(ctx, ''),

  services: (engine) => ({
    list: (uid) => Object.keys(readUser(engine, uid).got).filter((id) => BY_ID.has(id)),
    idsOf: (uid) => Object.keys(readUser(engine, uid).got).filter((id) => BY_ID.has(id)),
    all: () => ACHIEVEMENTS.map((a) => ({ id: a.id, icon: a.icon, name: a.name, desc: a.desc })),
    stats: (uid) => statsOf(engine, uid),
    check: (uid) => evaluate(engine, uid),
  }),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: true, config: {} },
    community: { enabled: true, config: {} },
    roleplay: { enabled: true, config: {} },
  },

  help: [
    `Achievements count everywhere YapOS is: messages, levels, /daily streaks, casino wins, YapOS Party games, quests, tickets and clans. Each pays a one-time ${CURRENCY.name} reward.`,
    'When you unlock one I send you a private DM, never a channel post. Turn that off with /achievements dm off.',
    'See your list with /achievements, or someone else\'s with /achievements @sam.',
    'Bot owner: /achievements reward msgs10k 300 changes a reward, /achievements reward off pauses them.',
  ],

  dispose: (engine) => { states.delete(engine); },
});
