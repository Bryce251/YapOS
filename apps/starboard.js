import { defineApp } from '../engine/apps.js';
import { card, dialog, button, linkButton, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, clip } from '../engine/parse.js';
import { messageFiles, messageLink, isPicture } from '../engine/links.js';
import { explain } from '../engine/errors.js';
import { accept, reject, isBlank, boolField, channelById } from '../engine/dashboard.js';

const ID = 'starboard';
const cid = (action, ...args) => customId(ID, action, ...args);

const GOLD = 0xf1c40f;
const DEFAULT_EMOJI = '⭐';
const DEFAULT_THRESHOLD = 3;
const MAX_THRESHOLD = 100;
const MAX_POSTS = 1000;
const SETTLE_MS = 800;
const SHORTCODES = { '⭐': ['star'], '🌟': ['star2', 'glowing_star'], '💫': ['dizzy'], '🔥': ['fire'], '❤️': ['heart'], '💯': ['100'] };
const CUSTOM_EMOJI = /^<a?:[\w~-]{1,32}:[\w-]{1,64}>$/;

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { timers: new Map(), running: new Map() };
    states.set(engine, s);
  }
  return s;
}

const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const postsKey = (sid) => `${sid}.posts`;
const readPosts = (engine, sid) => engine.store.get(ID, postsKey(sid), {}) || {};

function savePost(engine, sid, messageId, post) {
  engine.store.update(ID, postsKey(sid), (cur) => {
    const all = { ...(cur || {}) };
    if (post) all[messageId] = post; else delete all[messageId];
    const ids = Object.keys(all);
    if (ids.length > MAX_POSTS) {
      ids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      for (const old of ids.slice(0, ids.length - MAX_POSTS)) delete all[old];
    }
    return all;
  }, {});
}

function emojiMatches(want, got) {
  const g = String(got ?? '').trim();
  const w = String(want || DEFAULT_EMOJI).trim();
  if (!g) return false;
  if (g === w || g.replace(/️/g, '') === w.replace(/️/g, '')) return true;
  const name = g.replace(/^:|:$/g, '').toLowerCase();
  return (SHORTCODES[w] || []).includes(name);
}

function cleanEmoji(raw) {
  const e = String(raw ?? '').trim();
  if (!e) return null;
  if (CUSTOM_EMOJI.test(e)) return e;
  if (e.length > 16 || /[\w\s<>@#:]/.test(e)) return null;
  return /\p{Extended_Pictographic}/u.test(e) ? e : null;
}

const clampThreshold = (n) => Math.min(MAX_THRESHOLD, Math.max(1, Math.round(Number(n) || DEFAULT_THRESHOLD)));

function starLevel(count) {
  if (count >= 20) return '💫';
  if (count >= 10) return '🌟';
  return '⭐';
}

async function authorLabel(engine, sid, m) {
  if (typeof m.author === 'string' && m.author) return m.author;
  const named = m.author?.display_name || m.author?.username || m.author_name;
  if (named) return named;
  const id = m.author_id || m.author?.id;
  if (!id) return 'someone';
  const mem = await engine.perms.member(sid, id).catch(() => null);
  return mem?.nickname || mem?.display_name || mem?.username || 'someone';
}

function headerText(cfg, count, channelId) {
  const emoji = cfg.emoji || DEFAULT_EMOJI;
  const icon = emoji === DEFAULT_EMOJI ? starLevel(count) : emoji;
  return `${icon} **${count}** · <#${channelId}>`;
}

async function buildPost(engine, sid, m, channelId, messageId, cfg, count) {
  const files = messageFiles(m);
  const picture = files.find((f) => isPicture(f.name) || isPicture(f.url));
  const others = files.filter((f) => f !== picture);
  const link = messageLink(sid, channelId, messageId);
  const name = await authorLabel(engine, sid, m);
  const fields = [];
  if (others.length) fields.push({ name: others.length === 1 ? 'Attachment' : 'Attachments', value: clip(others.map((f) => `[${f.name}](${f.url})`).join('\n'), 1000) });
  fields.push({ name: 'Source', value: `[Jump to message](${link})` });
  const embed = card({ title: clip(name, 200), url: link, body: m.content ? clip(m.content, 3500) : picture ? null : '*(no text)*', fields, color: GOLD, footer: `In #${await channelName(engine, sid, channelId)}`, image: picture?.url });
  const sent = Date.parse(m.created_at);
  if (Number.isFinite(sent)) embed.timestamp = new Date(sent).toISOString();
  return {
    content: headerText(cfg, count, channelId),
    opts: { embeds: [embed], components: [row(linkButton('Jump to message', link, '↗️'))] },
  };
}

async function channelName(engine, sid, channelId) {
  const list = await engine.cache.channels(sid).catch(() => []);
  return list.find((c) => c.id === channelId)?.name || 'channel';
}

async function countStars(engine, channelId, messageId, cfg, authorId) {
  const list = await engine.bot.reactions(channelId, messageId);
  const users = new Set();
  for (const r of list || []) {
    if (!emojiMatches(cfg.emoji, r.emoji)) continue;
    if (!r.user_id || r.user_id === botId(engine)) continue;
    if (!cfg.selfStar && authorId && r.user_id === authorId) continue;
    users.add(r.user_id);
  }
  return users.size;
}

async function logProblem(engine, sid, text) {
  const embed = card({ title: '⭐ Starboard problem', body: text, color: 'warn' });
  try {
    const mod = engine.service('mod');
    if (mod?.log && engine.settings.isEnabled(sid, 'mod')) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (ch) await engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low' });
  } catch (e) {
    engine.log.debug('[starboard] could not log a problem', e?.message);
  }
}

async function update(engine, sid, channelId, messageId, authorHint) {
  const cfg = cfgOf(engine, sid);
  if (!cfg.channelId || channelId === cfg.channelId) return;
  let message;
  try {
    message = await engine.bot.message(channelId, messageId);
  } catch (e) {
    engine.log.debug('[starboard] could not read the starred message', e?.message);
    return;
  }
  if (!message) return;
  const authorId = message.author_id || message.author?.id || authorHint || null;
  if (authorId && authorId === botId(engine)) return;
  let count;
  try {
    count = await countStars(engine, channelId, messageId, cfg, authorId);
  } catch (e) {
    engine.log.debug('[starboard] could not count reactions', e?.message);
    return;
  }
  const threshold = clampThreshold(cfg.threshold);
  const post = readPosts(engine, sid)[messageId];
  if (post?.starId) {
    if (post.count === count) return;
    savePost(engine, sid, messageId, { ...post, count });
    try {
      await engine.budget.edit({ channelId: post.channelId, messageId: post.starId, content: headerText(cfg, count, channelId) });
    } catch (e) {
      if (e?.status === 404) savePost(engine, sid, messageId, { ...post, count, starId: null, gone: true });
      engine.log.debug('[starboard] could not update a starboard post', e?.message);
    }
    return;
  }
  if (post?.gone || count < threshold) return;
  const view = await buildPost(engine, sid, message, channelId, messageId, cfg, count);
  let sent;
  try {
    sent = await engine.budget.send({ serverId: sid, channelId: cfg.channelId, content: view.content, opts: view.opts, priority: 'low' });
  } catch (e) {
    const { body } = explain(e, { action: 'post on the starboard', perm: 'send_messages' });
    await logProblem(engine, sid, `A message reached ${count} stars, but I couldn't post it in <#${cfg.channelId}>.\n${body}`);
    return;
  }
  if (sent?.id) savePost(engine, sid, messageId, { starId: sent.id, channelId: cfg.channelId, sourceChannelId: channelId, count, authorId, at: Date.now() });
}

function queueUpdate(engine, sid, channelId, messageId, authorHint) {
  const st = stateOf(engine);
  const k = `${sid}:${messageId}`;
  if (st.timers.has(k)) return;
  const t = setTimeout(() => {
    st.timers.delete(k);
    const prev = st.running.get(k) || Promise.resolve();
    const next = prev.then(() => update(engine, sid, channelId, messageId, authorHint)).catch((e) => engine.log.debug('[starboard] update failed', e?.message));
    st.running.set(k, next);
    next.finally(() => { if (st.running.get(k) === next) st.running.delete(k); });
  }, Number.isFinite(engine.config?.starboardSettleMs) ? engine.config.starboardSettleMs : SETTLE_MS);
  t.unref?.();
  st.timers.set(k, t);
}

function onReaction(ctx, ev) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  if (!sid || !ev.channel_id || !ev.message_id) return;
  if (ev.user_id && ev.user_id === botId(engine)) return;
  const cfg = cfgOf(engine, sid);
  if (!cfg.channelId || ev.channel_id === cfg.channelId) return;
  if (!emojiMatches(cfg.emoji, ev.emoji)) return;
  queueUpdate(engine, sid, ev.channel_id, ev.message_id, ev.message_author_id);
}

function settingsView(ctx) {
  const cfg = ctx.config();
  const emoji = cfg.emoji || DEFAULT_EMOJI;
  const threshold = clampThreshold(cfg.threshold);
  const posts = Object.keys(readPosts(ctx.engine, ctx.serverId)).length;
  const fields = [
    { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Not set, so the starboard is off', inline: true },
    { name: 'Emoji', value: emoji, inline: true },
    { name: 'Stars needed', value: String(threshold), inline: true },
    { name: 'Own messages', value: cfg.selfStar ? 'Count' : "Don't count", inline: true },
    { name: 'Posts so far', value: String(posts), inline: true },
  ];
  const body = `When a message gets **${threshold}** ${emoji} reactions, I copy it to the starboard with a link back. The count updates as people react.\nTyped: \`/starboard #starboard\` · \`/starboard 5\` · \`/starboard emoji 🌟\` · \`/starboard self on\` · \`/starboard off\``;
  return {
    embeds: [card({ title: '⭐ Starboard', body, fields, color: GOLD })],
    components: [row(
      button('Channel', cid('chanform'), 'primary', '#️⃣'),
      button('Stars needed', cid('numform'), 'secondary', '🔢'),
      button('Emoji', cid('emojiform'), 'secondary', emoji.startsWith('<') ? '⭐' : emoji),
      button(cfg.selfStar ? 'Own stars: count' : "Own stars: don't count", cid('self'), 'secondary', '🙋'),
      cfg.channelId ? button('Turn off', cid('off'), 'danger', '⏹️') : null,
    )],
  };
}

function infoView(ctx) {
  const cfg = ctx.config();
  const emoji = cfg.emoji || DEFAULT_EMOJI;
  if (!cfg.channelId) return { embeds: [dialog.info('Starboard', "This server hasn't set up a starboard yet. An admin can run `/starboard #channel`.")] };
  return { embeds: [card({ title: '⭐ Starboard', body: `React with ${emoji} to messages you love. When one gets **${clampThreshold(cfg.threshold)}**, it goes up on <#${cfg.channelId}>.`, color: GOLD })] };
}

async function setChannel(ctx, token) {
  const ch = await ctx.findChannel(token);
  if (!ch) return ctx.warn("I couldn't find that channel", CHANNEL_HELP);
  const can = await ctx.engine.perms.botCan(ctx.serverId, 'send_messages', 'embed_links').catch(() => ({ ok: true }));
  ctx.patchConfig({ channelId: ch.id });
  const warn = can.ok === false ? `\n-# I may be missing **Send Messages** or **Embed Links**. Check my role can post in <#${ch.id}>.` : '';
  return ctx.ok('Starboard is on', `Messages with **${clampThreshold(ctx.config().threshold)}** ${ctx.config().emoji || DEFAULT_EMOJI} go to <#${ch.id}>.${warn}`);
}

const THRESHOLD_HELP = `Pick a whole number from 1 to ${MAX_THRESHOLD}, like \`/starboard 5\`.`;
const EMOJI_HELP = 'Send one emoji, like `/starboard emoji 🌟`.';
const CHANNEL_HELP = 'Mention it like `/starboard #starboard`, or type its name.';

function checkThreshold(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_THRESHOLD ? n : null;
}

function setThreshold(ctx, raw) {
  const n = checkThreshold(raw);
  if (n === null) return ctx.warn('How many stars?', THRESHOLD_HELP);
  ctx.patchConfig({ threshold: n });
  return ctx.ok('Saved', `A message needs **${n}** ${ctx.config().emoji || DEFAULT_EMOJI} to reach the starboard.`);
}

function setEmoji(ctx, raw) {
  const e = cleanEmoji(raw);
  if (!e) return ctx.warn("That emoji didn't work", EMOJI_HELP);
  ctx.patchConfig({ emoji: e });
  return ctx.ok('Saved', `People now react with ${e} to star messages.`);
}

async function runStarboard(ctx) {
  const toks = tokenize(String(ctx.args ?? '').trim());
  const admin = ctx.engine.perms.atLeast(await ctx.level().catch(() => 'member'), 'admin');
  if (!toks.length) return ctx.ephemeral(admin ? settingsView(ctx) : infoView(ctx));
  const sub = toks[0].toLowerCase();
  if (sub === 'help' || sub === '?') return ctx.ephemeral(infoView(ctx));
  await ctx.require('admin');
  if (['off', 'disable', 'stop'].includes(sub)) {
    ctx.patchConfig({ channelId: null });
    return ctx.ok('Starboard is off', 'Old starboard posts stay where they are. Turn it back on with `/starboard #channel`.');
  }
  if (['emoji', 'emote', 'react'].includes(sub)) return setEmoji(ctx, toks.slice(1).join(' '));
  if (['self', 'own'].includes(sub)) {
    const v = (toks[1] || '').toLowerCase();
    const on = ['on', 'yes', 'true', 'count'].includes(v) ? true : ['off', 'no', 'false'].includes(v) ? false : !ctx.config().selfStar;
    ctx.patchConfig({ selfStar: on });
    return ctx.ok('Saved', on ? 'People can star their own messages.' : "Stars on your own message don't count.");
  }
  if (['stars', 'need', 'needs', 'threshold', 'count', 'min'].includes(sub)) return setThreshold(ctx, toks[1]);
  if (/^\d+$/.test(sub)) return setThreshold(ctx, sub);
  if (['channel', 'set'].includes(sub)) return setChannel(ctx, toks.slice(1).join(' '));
  return setChannel(ctx, toks.join(' '));
}

const admin = (run) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const refresh = (ctx) => ctx.update(settingsView(ctx));

const DASHBOARD = [
  {
    key: 'channelId', label: 'Starboard channel', type: 'channel', web: true,
    help: 'Where starred messages are copied. Empty turns the starboard off.',
    validate: async (ctx, v) => {
      if (isBlank(v)) return accept(null);
      const ch = await channelById(ctx, v);
      return ch ? accept(ch.id) : reject(CHANNEL_HELP);
    },
  },
  {
    key: 'emoji', label: 'Star emoji', type: 'emoji', web: true, maxLength: 80,
    help: 'The reaction people use to star a message.',
    validate: (ctx, v) => {
      const e = typeof v === 'string' && v.length <= 80 ? cleanEmoji(v) : null;
      return e ? accept(e) : reject(EMOJI_HELP);
    },
  },
  {
    key: 'threshold', label: 'Stars needed', type: 'number', web: true, min: 1, max: MAX_THRESHOLD, step: 1,
    help: 'How many star reactions a message needs to reach the starboard.',
    validate: (ctx, v) => {
      const n = checkThreshold(v);
      return n === null ? reject(THRESHOLD_HELP) : accept(n);
    },
  },
  boolField({ key: 'selfStar', label: 'Count own stars', help: "Whether a member's star on their own message counts." }),
];

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Starboard',
  icon: '⭐',
  description: 'The best messages, pinned to a hall of fame by star reactions.',
  category: 'Community',
  panelPerm: 'member',

  defaults: {
    channelId: null,
    emoji: DEFAULT_EMOJI,
    threshold: DEFAULT_THRESHOLD,
    selfStar: false,
  },

  commands: {
    starboard: { description: 'Star messages into a hall of fame. Admins: /starboard #channel, /starboard 5, /starboard emoji 🌟', run: runStarboard },
  },

  components: {
    chanform: admin((ctx) => ctx.form({ title: 'Starboard channel', action: 'chansave', fields: [{ id: 'channel', label: 'Channel name', style: 'short', placeholder: 'starboard', max: 100 }] })),
    chansave: admin((ctx) => setChannel(ctx, ctx.values?.channel)),
    numform: admin((ctx) => ctx.form({ title: 'Stars needed', action: 'numsave', fields: [{ id: 'n', label: `Stars needed (1 to ${MAX_THRESHOLD})`, style: 'short', value: String(clampThreshold(ctx.config().threshold)), max: 3 }] })),
    numsave: admin((ctx) => setThreshold(ctx, ctx.values?.n)),
    emojiform: admin((ctx) => ctx.form({ title: 'Starboard emoji', action: 'emojisave', fields: [{ id: 'emoji', label: 'One emoji', style: 'short', value: ctx.config().emoji || DEFAULT_EMOJI, max: 80 }] })),
    emojisave: admin((ctx) => setEmoji(ctx, ctx.values?.emoji)),
    self: admin((ctx) => { ctx.patchConfig({ selfStar: !ctx.config().selfStar }); return refresh(ctx); }),
    off: admin((ctx) => { ctx.patchConfig({ channelId: null }); return refresh(ctx); }),
  },

  events: {
    reaction_add: onReaction,
    reaction_remove: onReaction,
  },

  yap: [
    { words: ['starboard', 'stars', 'hof'], run: runStarboard },
  ],

  dashboard: DASHBOARD,

  panel: async (ctx) => {
    const admin = ctx.engine.perms.atLeast(await ctx.level().catch(() => 'member'), 'admin');
    return ctx.ephemeral(admin ? settingsView(ctx) : infoView(ctx));
  },

  help: [
    'React with ⭐ to messages you love. When one gets enough stars (3 by default), it goes up on the starboard with a link back to it.',
    'Admins: `/starboard #starboard` turns it on · `/starboard 5` sets the stars needed · `/starboard emoji 🌟` · `/starboard self on` lets people star their own messages · `/starboard off`.',
  ],

  dispose: (engine) => {
    const st = states.get(engine);
    if (st) for (const t of st.timers.values()) clearTimeout(t);
    states.delete(engine);
  },
});
