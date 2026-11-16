import { defineApp } from '../engine/apps.js';
import { card } from '../engine/ui.js';
import { clip } from '../engine/parse.js';

const ID = 'party';
const ICON = '🎉';
const COOLDOWN_MS = 10 * 60_000;
const USER_COOLDOWN_MS = 2 * 60_000;
const MEMO_LIMIT = 2000;
const DIGEST_KIND = `${ID}.digest`;
const DIGEST_KEY = 'digest';
const DIGEST_TIME = '18:00';
const REPORTS_URL = 'https://yapos.dev/party/reports';

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { posted: new Map() };
    states.set(engine, s);
  }
  return s;
}

const nowOf = (engine) => (typeof engine.scheduler?.now === 'function' ? engine.scheduler.now() : Date.now());
const ownerOf = (engine) => engine.config?.ownerId || engine.bot.me?.bot?.owner_id || null;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const waitText = (ms) => {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  return `${min} minute${min === 1 ? '' : 's'}`;
};

export function inviteText(channelId) {
  return `${ICON} A YapOS Party is on in <#${channelId}>! Join the call, then open **Activities → YapOS Party**.`;
}

export function digestText(open) {
  const n = Math.floor(Number(open));
  if (!(n > 0)) return null;
  return `You have ${n} open YapOS Party report${n === 1 ? '' : 's'}: ${REPORTS_URL}`;
}

async function currentVoice(engine, sid, uid) {
  const list = await engine.bot.voice(sid);
  const entry = (list || []).find((v) => Array.isArray(v?.user_ids) && v.user_ids.includes(uid));
  return entry?.channel_id || null;
}

function prune(posted, t) {
  for (const [k, at] of posted) if (t - at >= (k.startsWith('user:') ? USER_COOLDOWN_MS : COOLDOWN_MS)) posted.delete(k);
  if (posted.size > MEMO_LIMIT) posted.clear();
}

function howCard() {
  return card({
    title: `${ICON} YapOS Party`,
    body: [
      'Games you play together inside a voice call: drawing, words, quizzes and quick party games.',
      '',
      '**Start one**',
      '1. Join a voice channel.',
      '2. Open **Activities → YapOS Party** in the call.',
      '3. Run **/party** here to invite everyone. Or name the channel: `/party Lounge`.',
      '',
      '-# One invite per voice channel every 10 minutes.',
    ].join('\n'),
    color: 'games',
  });
}

const showHow = (ctx) => ctx.ephemeral({ embeds: [howCard()] });

async function runParty(ctx) {
  const { engine, serverId: sid } = ctx;
  const arg = String(ctx.args ?? '').trim();
  if (/^(help|\?)$/i.test(arg)) return showHow(ctx);

  let channelId = null;
  if (arg) {
    const ch = await ctx.findChannel(arg, 'voice');
    if (!ch) return ctx.warn("I couldn't find that voice channel", `There's no voice channel called **${clip(arg.replace(/[*_`~|<>@#]/g, ''), 60) || 'that'}** that I can see. Check the name, or join the call and run **/party** on its own.`);
    channelId = ch.id;
  } else {
    try {
      channelId = await currentVoice(engine, sid, ctx.userId);
    } catch (e) {
      engine.log.debug(`[party] voice lookup failed: ${e?.message}`);
      return ctx.warn("I can't see who's in voice right now", 'Name the voice channel instead, like `/party Lounge`.');
    }
    if (!channelId) return ctx.warn("You're not in a voice channel", 'Join a voice channel first, then run **/party** again. Or name one, like `/party Lounge`.');
  }

  const st = stateOf(engine);
  const t = nowOf(engine);
  prune(st.posted, t);
  const key = `${sid}:${channelId}`;
  const last = st.posted.get(key);
  if (last !== undefined && t - last < COOLDOWN_MS) {
    return ctx.info('Already invited', `I posted a party invite for <#${channelId}> a moment ago. You can post another in ${waitText(COOLDOWN_MS - (t - last))}.`);
  }
  if (!ctx.channelId) return ctx.warn('Use this in a channel', 'Run **/party** in a text channel so I can post the invite there.');
  const userKey = `user:${sid}:${ctx.userId}`;
  const mine = st.posted.get(userKey);
  if (mine !== undefined && t - mine < USER_COOLDOWN_MS) {
    return ctx.info('One invite at a time', `You just posted a party invite. You can post another in ${waitText(USER_COOLDOWN_MS - (t - mine))}.`);
  }

  st.posted.set(key, t);
  st.posted.set(userKey, t);
  const embed = card({ title: `${ICON} YapOS Party`, body: `${inviteText(channelId)}\n\n-# Started by <@${ctx.userId}>`, color: 'games' });
  try {
    await engine.budget.send({ serverId: sid, channelId: ctx.channelId, content: '', opts: { embeds: [embed] }, priority: 'normal' });
  } catch (e) {
    st.posted.delete(key);
    st.posted.delete(userKey);
    throw e;
  }
  if (ctx.source?.interaction) return ctx.ok('Invite posted', `Everyone here can see it. Have fun in <#${channelId}>!`);
  return null;
}

export async function sendDigest(engine) {
  const text = digestText(engine.dashboard?.reportsOpen);
  if (!text) return undefined;
  const owner = ownerOf(engine);
  if (!owner) return undefined;
  const today = dayOf(nowOf(engine));
  const seen = engine.store.get(ID, DIGEST_KEY, null);
  if (seen?.day === today) return undefined;
  try {
    const dm = await engine.bot.dm(owner);
    await engine.budget.send({ serverId: null, channelId: dm, content: text, priority: 'low' });
    engine.store.set(ID, DIGEST_KEY, { day: today });
  } catch (e) {
    engine.log.warn(`[party] couldn't DM the daily report digest: ${e?.message}`);
  }
  return undefined;
}

function scheduleDigest(engine) {
  const sch = engine.scheduler;
  if (!sch?.schedule) return;
  try {
    if (sch.list({ kind: DIGEST_KIND, key: DIGEST_KEY }).length) return;
    sch.schedule({ kind: DIGEST_KIND, key: DIGEST_KEY, repeat: { daily: DIGEST_TIME, tz: 'UTC' } });
  } catch (e) {
    engine.log.warn(`[party] couldn't schedule the daily report digest: ${e?.message}`);
  }
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Party',
  icon: ICON,
  description: 'Invite your voice call to YapOS Party games.',
  category: 'Fun',
  phase: 3,

  commands: {
    party: { description: 'Invite everyone to a YapOS Party in your voice channel. Or name one: /party Lounge', run: runParty },
  },

  jobs: {
    digest: (job, engine) => sendDigest(engine),
  },

  yap: [{ words: ['party', 'activity'], run: runParty }],

  panelPerm: 'member',
  panel: showHow,

  help: [
    'Join a voice channel and run **/party** to post an invite. Or name a channel: `/party Lounge`.',
    'In the call, open **Activities → YapOS Party** to play. One invite per voice channel every 10 minutes.',
  ],

  init(engine) {
    scheduleDigest(engine);
  },

  dispose(engine) {
    states.delete(engine);
  },
});
