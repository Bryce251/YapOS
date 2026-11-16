import { defineApp } from '../engine/apps.js';
import { card, button, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { formatDuration } from '../engine/parse.js';
import { CURRENCY, GLOBAL_KEY, globalConfig } from '../engine/global.js';

const ID = 'quests';
const cid = (action, ...args) => customId(ID, action, ...args);

const NS = 'quests';
const PER_DAY = 3;
const BAR_WIDTH = 10;
const KEEP_DAYS = 3;
const PRUNE_EVERY_MS = 6 * 3600_000;
const PRUNE_BATCH = 5000;
const COLOR = 0x8e7cff;
const SAFE_ID = /^[\w-]{1,64}$/;
const SHARD_SOURCES = new Set(['daily', 'work', 'beg', 'game', 'party']);

export const QUESTS = Object.freeze([
  { id: 'party2', group: 'party', name: 'Play 2 YapOS Party games', goal: 2, reward: 50, needs: 'party' },
  { id: 'partywin', group: 'party', name: 'Win a YapOS Party game', goal: 1, reward: 75, needs: 'party' },
  { id: 'msgs30', group: 'chat', name: 'Send 30 messages', goal: 30, reward: 40 },
  { id: 'xp200', group: 'chat', name: 'Earn 200 XP', goal: 200, reward: 40, needs: 'xp' },
  { id: 'daily', group: 'daily', name: 'Claim your /daily', goal: 1, reward: 25, needs: 'economy' },
  { id: 'streak3', group: 'daily', name: 'Reach a 3-day /daily streak', goal: 3, reward: 60, needs: 'economy' },
  { id: 'casino100', group: 'casino', name: 'Win 100 Shards at the casino', goal: 100, reward: 50, needs: 'casino' },
  { id: 'voice15', group: 'voice', name: 'Spend 15 minutes in voice with friends', goal: 900, reward: 50, needs: 'voice', unit: 'minutes' },
  { id: 'shards150', group: 'shards', name: 'Earn 150 Shards', goal: 150, reward: 40, needs: 'economy' },
  { id: 'work2', group: 'shards', name: 'Work 2 shifts with /balance work', goal: 2, reward: 35, needs: 'work' },
]);
const BY_ID = new Map(QUESTS.map((q) => [q.id, q]));

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const fmt = (n) => Math.max(0, Math.trunc(Number(n) || 0)).toLocaleString('en-US');
const validId = (v) => typeof v === 'string' && SAFE_ID.test(v);

export function questDay(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 10);
}

export function nextReset(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hasApp(engine, id) {
  return !!engine.apps?.has?.(id);
}

export function availableQuests(engine) {
  const levelsCfg = hasApp(engine, 'levels') ? globalConfig(engine, 'levels') : null;
  const econCfg = hasApp(engine, 'economy') ? globalConfig(engine, 'economy') : null;
  const ok = {
    party: !!engine.dashboard?.enabled && hasApp(engine, 'levels'),
    xp: !!levelsCfg && levelsCfg.messageXp !== false,
    voice: !!levelsCfg && levelsCfg.voiceXp === true,
    economy: !!econCfg,
    work: !!econCfg && econCfg.workEnabled !== false,
    casino: !!econCfg && hasApp(engine, 'casino'),
  };
  if (econCfg && Number(econCfg.dailyAmount) === 0) ok.economy = false;
  return QUESTS.filter((q) => !q.needs || ok[q.needs]);
}

export function pickQuests(uid, day, pool) {
  const rand = seeded(hash(`${uid}:${day}`));
  const list = [...pool];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const out = [];
  const groups = new Set();
  for (const q of list) {
    if (out.length >= PER_DAY) break;
    if (groups.has(q.group)) continue;
    groups.add(q.group);
    out.push(q.id);
  }
  for (const q of list) {
    if (out.length >= PER_DAY) break;
    if (!out.includes(q.id)) out.push(q.id);
  }
  return out;
}

const fresh = (ids) => ids.filter((id) => BY_ID.has(id)).map((id) => ({ id, have: 0, claimed: false }));

function todayOf(engine, uid, t = nowOf(engine)) {
  const day = questDay(t);
  const saved = engine.store.get(NS, uid, null);
  if (saved && saved.day === day && Array.isArray(saved.quests)) {
    return { day, quests: saved.quests.filter((q) => q && BY_ID.has(q.id)), saved: true };
  }
  return { day, quests: fresh(pickQuests(uid, day, availableQuests(engine))), saved: false };
}

function mutateToday(engine, uid, fn, t = nowOf(engine)) {
  const day = questDay(t);
  let out;
  engine.store.update(NS, uid, (cur) => {
    let doc = cur && typeof cur === 'object' && cur.day === day && Array.isArray(cur.quests) ? cur : null;
    if (!doc) doc = { day, quests: fresh(pickQuests(uid, day, availableQuests(engine))) };
    doc.quests = doc.quests.filter((q) => q && BY_ID.has(q.id));
    doc.seen = t;
    out = fn(doc);
    return doc;
  }, null);
  return out;
}

function progress(engine, uid, matcher) {
  if (!validId(uid) || uid === engine.bot.me?.id) return false;
  const t = nowOf(engine);
  const today = todayOf(engine, uid, t);
  const wants = today.quests.some((q) => {
    const def = BY_ID.get(q.id);
    return !q.claimed && q.have < def.goal && matcher(def, q) !== null;
  });
  if (!wants) return false;
  return mutateToday(engine, uid, (doc) => {
    let changed = false;
    for (const q of doc.quests) {
      const def = BY_ID.get(q.id);
      if (q.claimed || q.have >= def.goal) continue;
      const next = matcher(def, q);
      if (next === null || next === undefined) continue;
      const value = Math.max(0, Math.min(def.goal, Math.floor(Number(next) || 0)));
      if (value !== q.have) { q.have = value; changed = true; }
    }
    return changed;
  }, t);
}

const add = (n) => (def, q) => (Number(q.have) || 0) + n;

function prune(engine) {
  const st = stateOf(engine);
  const t = nowOf(engine);
  if (t - st.prunedAt < PRUNE_EVERY_MS) return 0;
  st.prunedAt = t;
  const oldest = questDay(t - KEEP_DAYS * 86_400_000);
  let gone = 0;
  const keys = engine.store.keys ? engine.store.keys(NS) : [];
  for (const k of keys.slice(0, PRUNE_BATCH)) {
    const d = engine.store.get(NS, k, null);
    if (!d || typeof d.day !== 'string' || d.day < oldest) { engine.store.delete(NS, k); gone++; }
  }
  return gone;
}

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { prunedAt: -Infinity, busy: new Set() };
    states.set(engine, s);
  }
  return s;
}

function bar(have, goal) {
  const frac = goal > 0 ? Math.max(0, Math.min(1, have / goal)) : 0;
  const full = Math.round(frac * BAR_WIDTH);
  return `${'▰'.repeat(full)}${'▱'.repeat(BAR_WIDTH - full)}`;
}

function amountText(def, n) {
  if (def.unit === 'minutes') return `${fmt(Math.floor(n / 60))}/${fmt(Math.floor(def.goal / 60))} min`;
  return `${fmt(n)}/${fmt(def.goal)}`;
}

export function questsView(engine, uid, t = nowOf(engine)) {
  const today = todayOf(engine, uid, t);
  const lines = [];
  let ready = 0;
  let readyCount = 0;
  let left = 0;
  for (const q of today.quests) {
    const def = BY_ID.get(q.id);
    const done = q.have >= def.goal;
    const mark = q.claimed ? '✅' : done ? '🎁' : '▫️';
    const tail = q.claimed ? 'claimed' : done ? 'ready to claim!' : amountText(def, q.have);
    lines.push(`${mark} **${def.name}** · ${fmt(def.reward)} ${CURRENCY.emoji}`);
    lines.push(`${bar(q.claimed ? def.goal : q.have, def.goal)}  ${tail}`);
    if (done && !q.claimed) { ready += def.reward; readyCount++; }
    if (!q.claimed) left++;
  }
  const wait = formatDuration(nextReset(t) - t);
  let body;
  if (!today.quests.length) body = 'No quests today. Check back tomorrow!';
  else body = [...lines, '', left ? `-# Finish a quest, then press **Claim** to collect your ${CURRENCY.name}.` : '-# All done for today. Nice work! 🎉'].join('\n');
  const buttons = [];
  if (readyCount) buttons.push(button(`Claim ${fmt(ready)} ${CURRENCY.name}`, cid('claim', uid), 'success', CURRENCY.emoji));
  buttons.push(button('Refresh', cid('view', uid), 'secondary', '🔄'));
  return {
    embeds: [card({ title: '📜 Daily quests', body, color: COLOR, footer: `New quests in ${wait} · the same quests on every server` })],
    components: [row(buttons)],
  };
}

async function claim(engine, uid, sid) {
  const st = stateOf(engine);
  if (st.busy.has(uid)) return { busy: true };
  st.busy.add(uid);
  try {
    const eco = engine.service('economy');
    if (!eco || typeof eco.add !== 'function') return { noEconomy: true };
    const t = nowOf(engine);
    const today = todayOf(engine, uid, t);
    const due = today.quests.filter((q) => !q.claimed && q.have >= BY_ID.get(q.id).goal).map((q) => q.id);
    if (!due.length) return { paid: 0, quests: [] };
    const marked = mutateToday(engine, uid, (doc) => {
      const got = [];
      for (const q of doc.quests) if (due.includes(q.id) && !q.claimed && q.have >= BY_ID.get(q.id).goal) { q.claimed = true; got.push(q.id); }
      return got;
    }, t);
    let paid = 0;
    const done = [];
    for (const id of marked) {
      const def = BY_ID.get(id);
      try {
        await eco.add(sid || GLOBAL_KEY, uid, def.reward, `Daily quest: ${def.name}`);
        paid += def.reward;
        done.push(id);
      } catch (e) {
        engine.log.warn(`[quests] couldn't pay a quest reward: ${e?.message}`);
        mutateToday(engine, uid, (doc) => { const q = doc.quests.find((x) => x.id === id); if (q) q.claimed = false; }, t);
      }
    }
    return { paid, quests: done };
  } finally {
    st.busy.delete(uid);
  }
}

async function showQuests(ctx) {
  prune(ctx.engine);
  return ctx.panel(questsView(ctx.engine, ctx.userId));
}

function onMessage(ctx, msg) {
  const uid = msg?.author_id;
  if (!msg?.server_id || !uid || msg.author_bot || msg.command) return;
  if (!String(msg.content || '').trim() && !msg.attachment) return;
  progress(ctx.engine, uid, (def, q) => (def.id === 'msgs30' ? add(1)(def, q) : null));
}

function onParty(ctx, ev) {
  const uid = ev?.user;
  progress(ctx.engine, uid, (def, q) => {
    if (def.id === 'party2') return add(1)(def, q);
    if (def.id === 'partywin') return ev.won === true ? add(1)(def, q) : null;
    return null;
  });
}

function onXp(ctx, ev) {
  const amount = Math.max(0, Math.floor(Number(ev?.amount) || 0));
  const voice = Math.max(0, Math.floor(Number(ev?.voiceSeconds) || 0));
  progress(ctx.engine, ev?.user, (def, q) => {
    if (def.id === 'xp200') return amount > 0 ? add(amount)(def, q) : null;
    if (def.id === 'voice15') return voice > 0 ? add(voice)(def, q) : null;
    return null;
  });
}

function onShards(ctx, ev) {
  const amount = Math.max(0, Math.floor(Number(ev?.amount) || 0));
  if (!amount) return;
  const source = String(ev?.source || '');
  progress(ctx.engine, ev?.user, (def, q) => {
    if (def.id === 'casino100') return source === 'casino' ? add(amount)(def, q) : null;
    if (def.id === 'shards150') return SHARD_SOURCES.has(source) ? add(amount)(def, q) : null;
    if (def.id === 'work2') return source === 'work' ? add(1)(def, q) : null;
    return null;
  });
}

function onDaily(ctx, ev) {
  const streak = Math.max(0, Math.floor(Number(ev?.streak) || 0));
  progress(ctx.engine, ev?.user, (def, q) => {
    if (def.id === 'daily') return 1;
    if (def.id === 'streak3') return Math.max(Number(q.have) || 0, streak);
    return null;
  });
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Quests',
  icon: '📜',
  description: `Three small daily quests for bonus ${CURRENCY.name}, the same on every server.`,
  category: 'Fun',
  panelPerm: 'member',

  commands: {
    quests: { description: `Your 3 daily quests and their progress. Finish them for bonus ${CURRENCY.name}: /quests`, serverOnly: false, run: showQuests },
  },

  components: {
    view: { owner: true, ownerArg: 0, run: async (ctx) => ctx.update(questsView(ctx.engine, ctx.userId)) },
    claim: {
      owner: true,
      ownerArg: 0,
      run: async (ctx) => {
        const res = await claim(ctx.engine, ctx.userId, ctx.serverId);
        if (res.busy) return ctx.info('One moment', 'Your last claim is still going through.');
        if (res.noEconomy) return ctx.warn("I can't pay out right now", `The Economy app isn't running, so no ${CURRENCY.name} can be paid. Your quests stay ready to claim.`);
        await ctx.update(questsView(ctx.engine, ctx.userId));
        if (!res.paid) return ctx.info('Nothing to claim yet', 'Finish a quest first, then come back.');
        return undefined;
      },
    },
  },

  events: {
    message: onMessage,
    'party:played': onParty,
    'xp:gained': onXp,
    'shards:earned': onShards,
    'economy:daily': onDaily,
  },

  yap: [
    { words: ['quests', 'quest', 'missions'], run: showQuests },
  ],

  panel: async (ctx) => ctx.panel(questsView(ctx.engine, ctx.userId)),

  services: (engine) => ({
    today: (uid) => todayOf(engine, uid),
    view: (uid) => questsView(engine, uid),
    claim: (uid, sid) => claim(engine, uid, sid),
  }),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: true, config: {} },
    community: { enabled: true, config: {} },
    roleplay: { enabled: true, config: {} },
  },

  help: [
    `Everyone gets 3 quests a day, like "Send 30 messages" or "Win a YapOS Party game". Finish one and press Claim for 25 to 75 ${CURRENCY.name}.`,
    'Quests are yours, not the server\'s: progress counts on every server and new ones arrive at midnight UTC.',
    'Open them with /quests or /yap quests.',
  ],

  dispose: (engine) => { states.delete(engine); },
});
