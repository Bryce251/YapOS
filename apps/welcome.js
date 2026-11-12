import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, onOff } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, fillTemplate, ordinal, clip, parseBool, didYouMean, levenshtein, resolveChannel, resolveRole } from '../engine/parse.js';
import { explain, friendly, looksLikeFeatureOff, permName } from '../engine/errors.js';
import { accept, reject, isBlank, boolField, idList, safeId } from '../engine/dashboard.js';

const ID = 'welcome';
const cid = (action, ...args) => customId(ID, action, ...args);

const MAX_AUTOROLES = 5;
const BURST_WINDOW_MS = 30_000;
const BURST_LIMIT = 10;
const BURST_QUIET_MS = 4_000;
const BURST_MAX_WAIT_MS = 20_000;
const BURST_NAMES = 3;
const LATE_WAIT_MS = 5_000;
const PLACEHOLDERS = ['user', 'username', 'server', 'count', 'count_ord'];
const ISSUE_KEEP = 3;
const NAME_MAX = 64;
const STAFF_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'kick_members', 'ban_members', 'timeout_members', 'mention_everyone', 'move_members'];

const DEFAULT_JOIN = "Welcome {user} to **{server}**! You're our {count_ord} member.";
const DEFAULT_LEAVE = '**{username}** left **{server}**. We are now {count} members.';
const DEFAULT_DM = "Hi {username}, welcome to **{server}**! Say hi when you're ready.";
const DEFAULT_TITLE = '👋 Welcome!';

const IMAGE_HOSTS = new Set([
  'i.imgur.com', 'media.tenor.com', 'media.giphy.com', 'i.giphy.com', 'upload.wikimedia.org',
  'raw.githubusercontent.com', 'avatars.githubusercontent.com', 'user-images.githubusercontent.com',
  'i.ytimg.com', 'cdn.discordapp.com', 'media.discordapp.net', 'pbs.twimg.com', 'i.redd.it',
  'static-cdn.jtvnw.net', 'i.scdn.co', 's4.anilist.co', 'cdn.myanimelist.net', 'nekos.best', 'cdn.weeb.sh',
]);
const IMAGE_HOST_SUFFIXES = ['klipy.com', 'rbxcdn.com', 'yapin.gg'];

function checkImage(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return { ok: true, url: null };
  if (raw.length > 512) return { ok: false, reason: 'That picture link is too long. Links can be up to 512 characters.' };
  let parsed;
  try { parsed = new URL(raw); } catch { return { ok: false, reason: "That doesn't look like a link. Paste a full picture link that starts with https://." }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'Picture links have to start with **https://**.' };
  const host = parsed.hostname.toLowerCase();
  const allowed = IMAGE_HOSTS.has(host) || IMAGE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (!allowed) return { ok: false, reason: `Yapin' doesn't show pictures from **${host}** in cards. Upload the picture to Yapin' or **i.imgur.com** and paste that link instead.` };
  return { ok: true, url: raw };
}

const PRESETS = {
  gaming: {
    enabled: true,
    config: {
      join: true, leave: true, card: true,
      joinText: "🎮 {user} just spawned into **{server}**! You're player number {count}. Grab your roles and squad up.",
      leaveText: '🎮 **{username}** logged off from **{server}**. GG!',
      cardTitle: '🎮 New player joined',
      dmText: 'GG for joining **{server}**, {username}! Check the rules and find a squad.',
    },
  },
  friends: {
    enabled: true,
    config: {
      join: true, leave: true, card: true,
      joinText: "Hey {user}! 💛 Welcome to **{server}**, make yourself at home. You're our {count_ord} friend here.",
      leaveText: '💛 **{username}** headed out. We will miss you!',
      cardTitle: '💛 A new friend!',
      dmText: 'Hey {username}, so glad you joined **{server}**! Come say hi.',
    },
  },
  study: {
    enabled: true,
    config: {
      join: true, leave: false, card: true,
      joinText: '📚 Welcome {user} to **{server}**! Read the rules, set a goal and happy studying. You are member #{count}.',
      leaveText: '📚 **{username}** left the study hall. Good luck out there!',
      cardTitle: '📚 New study buddy',
      dmText: 'Welcome to **{server}**, {username}! Tip: say hi and share what you are studying.',
    },
  },
  community: {
    enabled: true,
    config: {
      join: true, leave: false, card: true,
      joinText: DEFAULT_JOIN,
      leaveText: DEFAULT_LEAVE,
      cardTitle: DEFAULT_TITLE,
      dmText: DEFAULT_DM,
    },
  },
  roleplay: {
    enabled: true,
    config: {
      join: true, leave: true, card: true,
      joinText: '📜 A new traveller arrives... Welcome, {user}, to **{server}**. Read the lore and craft your character. You are the {count_ord} soul to find us.',
      leaveText: '📜 **{username}** has left the realm. Their tale ends here, for now.',
      cardTitle: '📜 A traveller arrives',
      dmText: 'Greetings, {username}. The realm of **{server}** awaits. Read the lore before you begin.',
    },
  },
};

const runtimes = new WeakMap();

function runtime(engine) {
  if (!runtimes.has(engine)) runtimes.set(engine, { bursts: new Map(), logged: new Map(), late: new Map() });
  return runtimes.get(engine);
}

function burstFor(engine, sid) {
  const { bursts } = runtime(engine);
  if (!bursts.has(sid)) bursts.set(sid, { times: [], pending: [], total: 0, firstAt: 0, timer: null });
  return bursts.get(sid);
}

function noteJoin(engine, sid, at = Date.now()) {
  const b = burstFor(engine, sid);
  b.times.push(at);
  while (b.times.length && b.times[0] <= at - BURST_WINDOW_MS) b.times.shift();
  return b.times.length > BURST_LIMIT;
}

async function serverName(engine, sid) {
  try { return (await engine.perms.server(sid))?.name || 'the server'; } catch { return 'the server'; }
}

async function memberCount(engine, sid) {
  const live = await engine.bot.memberCounts(sid).catch(() => null);
  if (live?.member_count) return live.member_count;
  return (await engine.perms.server(sid).catch(() => null))?.member_count || 0;
}

async function textChannels(engine, sid) {
  try { return (await engine.cache.channels(sid)).filter((c) => (c.type || c.kind) === 'text'); } catch { return []; }
}

async function joinChannel(engine, sid, cfg) {
  const list = await textChannels(engine, sid);
  if (cfg.channel) {
    const hit = list.find((c) => c.id === cfg.channel);
    if (hit) return hit;
    if (!list.length) return { id: cfg.channel, name: 'welcome channel' };
  }
  const found = await engine.detectChannels(sid).catch(() => ({}));
  return found.welcome || found.general || list[0] || null;
}

async function leaveChannel(engine, sid, cfg) {
  if (cfg.leaveChannel) {
    const list = await textChannels(engine, sid);
    const hit = list.find((c) => c.id === cfg.leaveChannel);
    if (hit) return hit;
    if (!list.length) return { id: cfg.leaveChannel, name: 'goodbye channel' };
  }
  return joinChannel(engine, sid, cfg);
}

function safeName(name) {
  const cleaned = String(name ?? '').replace(/[<>[\]`\r\n]/g, '').replace(/@/g, '@\u200b').replace(/:\/\//g, ':\u200b//').trim();
  return clip(cleaned, NAME_MAX) || 'someone';
}

function vars({ userId, username, server, count }) {
  return { user: `<@${userId}>`, username: safeName(username), server, count, count_ord: ordinal(count) };
}

function joinMessage(cfg, v) {
  const text = clip(fillTemplate(cfg.joinText || DEFAULT_JOIN, v), cfg.card ? 4000 : 2000);
  if (!cfg.card) return { content: text };
  const img = checkImage(cfg.imageUrl);
  return {
    content: v.user,
    embeds: [card({ title: fillTemplate(cfg.cardTitle || DEFAULT_TITLE, v), body: text, color: 'welcome', footer: `Member #${v.count}`, thumbnail: img.ok ? img.url || undefined : undefined })],
  };
}

function leaveMessage(cfg, v) {
  return { content: clip(fillTemplate(cfg.leaveText || DEFAULT_LEAVE, v), 2000) };
}

function batchText(people, total, server) {
  const tags = people.map((p) => `<@${p.id}>`);
  let who;
  if (total <= 1) who = tags[0];
  else if (total <= BURST_NAMES && tags.length === total) who = `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
  else who = `${tags.slice(0, 2).join(', ')} and ${total - 2} others`;
  return `👋 Welcome ${who} to **${server}**!`;
}

function recordIssue(engine, sid, text) {
  engine.store.update(ID, sid, (s) => {
    s.issues = [{ text, at: Date.now() }, ...(s.issues || [])].slice(0, ISSUE_KEEP);
    return s;
  }, {});
}

async function logOnce(engine, sid, key, title, body) {
  recordIssue(engine, sid, `${title}: ${body}`);
  const { logged } = runtime(engine);
  if (!logged.has(sid)) logged.set(sid, new Set());
  const seen = logged.get(sid);
  if (seen.has(key)) return;
  seen.add(key);
  const embed = dialog.warn(title, body);
  const mod = engine.service('mod');
  try {
    if (mod?.log) return await mod.log(sid, embed);
    const logChannel = engine.settings.core(sid).logChannel;
    if (logChannel) await engine.budget.send({ serverId: sid, channelId: logChannel, opts: { embeds: [embed] }, priority: 'low' });
  } catch (e) {
    engine.log.warn(`[welcome] could not post to the log channel: ${e?.message}`);
  }
}

function forgetLogged(engine, sid, prefix) {
  const seen = runtime(engine).logged.get(sid);
  if (!seen) return;
  for (const k of [...seen]) if (k.startsWith(prefix)) seen.delete(k);
}

async function giveAutoroles(engine, sid, userId, cfg) {
  const ids = (cfg.autoroles || []).slice(0, MAX_AUTOROLES);
  for (const rid of ids) {
    if (engine.caps.state(sid, 'roles') === false) {
      await logOnce(engine, sid, 'roles-off', 'Starter roles are paused', "Giving roles doesn't work on this server right now (it's still a testing feature on Yapin'). I'll try again later.");
      return;
    }
    try {
      await engine.bot.addRole(sid, userId, rid);
      engine.caps.mark(sid, 'roles', true);
    } catch (e) {
      if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
      const check = await engine.perms.canManageRole(sid, rid).catch(() => ({ ok: true }));
      const name = check.role?.name || (await engine.perms.roles(sid).catch(() => [])).find((r) => r.id === rid)?.name || 'a starter role';
      const reason = check.ok ? explain(e, { action: 'give that role', perm: 'manage_roles' }).body : check.reason;
      await logOnce(engine, sid, `role:${rid}`, `I couldn't give **${name}** to new members`, reason);
    }
  }
}

async function sendDm(engine, sid, userId, cfg, v) {
  if (engine.caps.state(sid, 'dms') === false) return 'paused';
  try {
    await engine.bot.dmSend(userId, clip(fillTemplate(cfg.dmText || DEFAULT_DM, v), 2000));
    engine.caps.mark(sid, 'dms', true);
    engine.store.update(ID, sid, (s) => { s.dmIssue = null; return s; }, {});
    return 'sent';
  } catch (e) {
    engine.caps.mark(sid, 'dms', false, e?.message);
    const reason = looksLikeFeatureOff(e) ? "DMs from bots are still a testing feature on Yapin' and don't work here yet." : "Yapin' didn't let me send the DM.";
    engine.store.update(ID, sid, (s) => { s.dmIssue = { reason, at: Date.now() }; return s; }, {});
    await logOnce(engine, sid, 'dm', 'Welcome DMs are paused', `${reason} I'll stop trying for a few hours. Join messages in the channel still work.`);
    return 'failed';
  }
}

async function flushBurst(engine, sid) {
  const b = runtime(engine).bursts.get(sid);
  if (!b || !b.total) return null;
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  const people = b.pending.splice(0);
  const total = b.total;
  b.total = 0;
  b.firstAt = 0;
  if (!engine.settings.isEnabled(sid, ID)) return null;
  const cfg = engine.settings.appConfig(sid, ID);
  if (!cfg.join) return null;
  const ch = await joinChannel(engine, sid, cfg);
  if (!ch) return null;
  const server = await serverName(engine, sid);
  try {
    return await engine.budget.send({ serverId: sid, channelId: ch.id, content: batchText(people, total, server), opts: {}, priority: 'normal' });
  } catch (e) {
    await logOnce(engine, sid, 'send', "I couldn't post welcome messages", explain(e, { action: 'post in', target: `#${ch.name}`, perm: 'send_messages' }).body);
    return null;
  }
}

function queueBurst(engine, sid, person) {
  const b = burstFor(engine, sid);
  const now = Date.now();
  if (!b.total) b.firstAt = now;
  b.total += 1;
  if (b.pending.length < BURST_NAMES) b.pending.push(person);
  if (b.timer) clearTimeout(b.timer);
  const wait = Math.max(0, Math.min(BURST_QUIET_MS, b.firstAt + BURST_MAX_WAIT_MS - now));
  b.timer = setTimeout(() => { flushBurst(engine, sid).catch((e) => engine.log.warn(`[welcome] batch failed: ${e?.message}`)); }, wait);
  b.timer.unref?.();
}

function lateText(people, total) {
  const tags = people.map((p) => `<@${p.id}>`);
  let who;
  if (total <= 1) who = tags[0];
  else if (total <= BURST_NAMES && tags.length === total) who = `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
  else who = `${tags.slice(0, 2).join(', ')} and ${total - 2} others`;
  return `While I was offline, ${total} ${total === 1 ? 'person' : 'people'} joined: welcome ${who}!`;
}

async function flushLate(engine, sid) {
  const { late } = runtime(engine);
  const batch = late.get(sid);
  if (!batch) return null;
  late.delete(sid);
  if (batch.timer) clearTimeout(batch.timer);
  if (!batch.total || !engine.settings.isEnabled(sid, ID)) return null;
  const cfg = engine.settings.appConfig(sid, ID);
  if (!cfg.join) return null;
  const ch = await joinChannel(engine, sid, cfg);
  if (!ch) return null;
  try {
    return await engine.budget.send({ serverId: sid, channelId: ch.id, content: lateText(batch.people, batch.total), opts: {}, priority: 'normal' });
  } catch (e) {
    await logOnce(engine, sid, 'send', "I couldn't post welcome messages", explain(e, { action: 'post in', target: `#${ch.name}`, perm: 'send_messages' }).body);
    return null;
  }
}

function queueLate(engine, sid, person) {
  const { late } = runtime(engine);
  if (!late.has(sid)) late.set(sid, { ids: new Set(), people: [], total: 0, timer: null });
  const batch = late.get(sid);
  if (batch.ids.has(person.id)) return;
  batch.ids.add(person.id);
  batch.total += 1;
  if (batch.people.length < BURST_NAMES) batch.people.push(person);
  if (batch.timer) return;
  batch.timer = setTimeout(() => { flushLate(engine, sid).catch((e) => engine.log.warn(`[welcome] late batch failed: ${e?.message}`)); }, LATE_WAIT_MS);
  batch.timer.unref?.();
}

function placeholderProblem(text) {
  for (const m of String(text ?? '').matchAll(/\{(\w+)\}/g)) {
    if (PLACEHOLDERS.includes(m[1])) continue;
    const guess = didYouMean(m[1], PLACEHOLDERS, { limit: 1 })[0];
    return `{${clip(m[1], 30)}} isn't a placeholder I know.${guess ? ` Did you mean {${guess}}?` : ''}\n-# Words you can use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`;
  }
  return null;
}

async function postJoin(ctx, ch, msg) {
  try {
    return await ctx.send(ch.id, msg, { priority: 'normal' });
  } catch (e) {
    await logOnce(ctx.engine, ctx.serverId, 'send', "I couldn't post welcome messages", explain(e, { action: 'post in', target: `#${ch.name}`, perm: 'send_messages' }).body);
    return null;
  }
}

async function onJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const cfg = ctx.config();
  if (ev.yaposLate) {
    if (cfg.join) queueLate(engine, sid, { id: ev.user_id, username: ev.username });
    if (cfg.autoroles?.length) await giveAutoroles(engine, sid, ev.user_id, cfg);
    return;
  }
  const bursting = noteJoin(engine, sid);
  const server = await serverName(engine, sid);
  const count = ev.member_count || (await memberCount(engine, sid));
  const v = vars({ userId: ev.user_id, username: ev.username, server, count });
  if (cfg.join) {
    if (bursting) queueBurst(engine, sid, { id: ev.user_id, username: ev.username });
    else {
      const ch = await joinChannel(engine, sid, cfg);
      if (ch) await postJoin(ctx, ch, joinMessage(cfg, v));
      else recordIssue(engine, sid, 'No channel to post welcome messages in. Pick one in /welcome.');
    }
  }
  if (cfg.autoroles?.length) await giveAutoroles(engine, sid, ev.user_id, cfg);
  if (cfg.dm && !bursting) await sendDm(engine, sid, ev.user_id, cfg, v);
}

async function onLeave(ctx, ev) {
  const { engine } = ctx;
  const cfg = ctx.config();
  if (!cfg.leave || ev.yaposLate) return;
  const ch = await leaveChannel(engine, ev.server_id, cfg);
  if (!ch) return;
  const server = await serverName(engine, ev.server_id);
  const count = ev.member_count ?? (await memberCount(engine, ev.server_id));
  const v = vars({ userId: ev.user_id, username: ev.username, server, count });
  await postJoin(ctx, ch, leaveMessage(cfg, v));
}

async function isAdmin(ctx) {
  return ctx.engine.perms.atLeast(await ctx.level(), 'admin');
}

function dmState(ctx, cfg) {
  if (!cfg.dm) return onOff(false);
  if (ctx.engine.caps.state(ctx.serverId, 'dms') === false) {
    const issue = ctx.store.server().dmIssue;
    return `⏸️ Paused: ${issue?.reason || "DMs don't work on this server right now."} I'll try again later.`;
  }
  return `${onOff(true)} *(testing feature)*`;
}

async function roleNames(ctx, ids) {
  const all = await ctx.roles().catch(() => []);
  return ids.map((id) => all.find((r) => r.id === id)?.name || 'deleted role');
}

async function panelView(ctx, { note, extraRow } = {}) {
  const cfg = ctx.config();
  const sid = ctx.serverId;
  const jc = await joinChannel(ctx.engine, sid, cfg);
  const lc = await leaveChannel(ctx.engine, sid, cfg);
  const chText = (c, set) => (c ? `<#${c.id}>${set ? '' : ' *(auto-picked)*'}` : 'none yet');
  const names = await roleNames(ctx, cfg.autoroles || []);
  const issues = ctx.store.server().issues || [];
  const img = cfg.imageUrl ? `\nPicture: ${cfg.imageUrl}` : '';
  const fields = [
    { name: 'Join messages', value: `${onOff(cfg.join)} in ${chText(jc, cfg.channel)}`, inline: true },
    { name: 'Leave messages', value: `${onOff(cfg.leave)} in ${cfg.leaveChannel ? chText(lc, true) : 'the same channel'}`, inline: true },
    { name: 'Welcome card', value: `${onOff(cfg.card)}${img}`, inline: true },
    { name: 'Welcome DM', value: dmState(ctx, cfg), inline: false },
    { name: `Starter roles (${names.length}/${MAX_AUTOROLES})`, value: names.length ? names.map((n) => `**${n}**`).join(', ') : 'none', inline: false },
    { name: 'Join text', value: clip(cfg.joinText || DEFAULT_JOIN, 1000), inline: false },
    { name: 'Leave text', value: clip(cfg.leaveText || DEFAULT_LEAVE, 1000), inline: false },
  ];
  if (issues.length) fields.push({ name: 'Recent problems', value: issues.map((i) => `• ${clip(i.text, 300)}`).join('\n'), inline: false });
  const main = card({
    title: '👋 Welcome',
    body: 'Greet new members, say goodbye, and hand out starter roles.\n-# Words you can use: {user} {username} {server} {count} {count_ord}',
    fields,
    color: 'welcome',
  });
  const components = [
    row(
      button(`Join: ${cfg.join ? 'On' : 'Off'}`, cid('toggle', 'join'), cfg.join ? 'success' : 'secondary', '👋'),
      button(`Leave: ${cfg.leave ? 'On' : 'Off'}`, cid('toggle', 'leave'), cfg.leave ? 'success' : 'secondary', '🚪'),
      button(`Card: ${cfg.card ? 'On' : 'Off'}`, cid('toggle', 'card'), cfg.card ? 'success' : 'secondary', '🪪'),
      button(`DM: ${cfg.dm ? 'On' : 'Off'}`, cid('toggle', 'dm'), cfg.dm ? 'success' : 'secondary', '✉️'),
    ),
    row(
      button('Channel', cid('pick', 'join'), 'primary', '#️⃣'),
      button('Leave channel', cid('pick', 'leave'), 'secondary', '🚪'),
      button('Edit messages', cid('edit'), 'primary', '📝'),
      button('Starter roles', cid('roles'), 'secondary', '🎭'),
    ),
    row(
      button('Preview', cid('preview'), 'secondary', '👀'),
      button('Test', cid('test'), 'secondary', '🧪'),
      button('Refresh', cid('home'), 'secondary', '🔄'),
    ),
  ];
  if (extraRow) components.push(extraRow);
  return { embeds: note ? [note, main] : [main], components };
}

async function previewView(ctx) {
  const { engine } = ctx;
  const cfg = ctx.config();
  const sid = ctx.serverId;
  const [server, count, ch] = await Promise.all([serverName(engine, sid), memberCount(engine, sid), joinChannel(engine, sid, cfg)]);
  const v = vars({ userId: ctx.userId, username: ctx.username, server, count });
  const msg = joinMessage(cfg, v);
  const where = ch ? `<#${ch.id}>` : 'no channel yet';
  const lines = [
    cfg.join ? `This is how new members are greeted in ${where}. This is only a preview, so nothing was posted there.` : 'Join messages are **off** right now, but this is how they would look.',
    msg.content && cfg.card ? `Message: ${msg.content}` : '',
    cfg.card ? '' : `\n${msg.content}`,
  ].filter(Boolean);
  const info = dialog.info('Preview', lines.join('\n'), { fields: [
    { name: `Leave message (${cfg.leave ? 'on' : 'off'})`, value: leaveMessage(cfg, v).content },
    ...(cfg.dm ? [{ name: 'Welcome DM', value: clip(fillTemplate(cfg.dmText || DEFAULT_DM, v), 1000) }] : []),
  ] });
  return { embeds: [info, ...(msg.embeds || [])] };
}

async function show(ctx, view) {
  if (ctx.kind === 'message') return ctx.reply(view);
  if (ctx.kind === 'button' || ctx.kind === 'select') return ctx.update(view);
  return ctx.ephemeral(view);
}

async function openPanel(ctx) {
  if (!ctx.serverId) return ctx.warn('Servers only', 'Welcome settings live in a server. Run **/welcome** there.');
  if (!(await isAdmin(ctx))) return ctx.ephemeral(await previewView(ctx));
  const view = await panelView(ctx);
  if (ctx.kind === 'message') return ctx.reply(view);
  return ctx.ephemeral(view);
}

async function channelPicker(ctx, which) {
  const list = (await textChannels(ctx.engine, ctx.serverId)).slice(0, 25);
  const cfg = ctx.config();
  const current = which === 'leave' ? cfg.leaveChannel : cfg.channel;
  const label = which === 'leave' ? 'goodbye' : 'welcome';
  const intro = dialog.info(`Pick the ${label} channel`, `Choose where ${label} messages go.\n-# You can also type \`/welcome ${which === 'leave' ? 'leave ' : ''}channel #name\`.`);
  const back = row(
    button('Back', cid('home'), 'secondary', '⬅️'),
    which === 'leave' ? button('Same as join channel', cid('chanreset'), 'secondary', '🔁') : null,
  );
  if (!list.length) return show(ctx, { embeds: [dialog.warn("I can't see any text channels", 'Give my role **View Channel** in the channel you want, then try again.')], components: [back] });
  const opts = list.map((c) => ({ label: `#${c.name}`, value: c.id, default: c.id === current }));
  const withSelect = { embeds: [intro], components: [select(cid('chanpick', which), opts, { placeholder: 'Pick a channel' }), back] };
  const btns = list.slice(0, 15).map((c) => button(`#${c.name}`, cid('chan', which, c.id), c.id === current ? 'success' : 'secondary'));
  const withButtons = { embeds: [intro], components: [...rows(btns).slice(0, 3), back] };
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => show(ctx, withSelect), () => show(ctx, withButtons));
}

async function setChannel(ctx, which, channel) {
  const key = which === 'leave' ? 'leaveChannel' : 'channel';
  const prev = ctx.config()[key] ?? null;
  ctx.patchConfig({ [key]: channel?.id ?? null });
  forgetLogged(ctx.engine, ctx.serverId, 'send');
  const undo = undoFor(ctx, `${which} channel`, { [key]: prev });
  const msg = channel ? `${which === 'leave' ? 'Goodbye' : 'Welcome'} messages now go to <#${channel.id}>.` : 'Goodbye messages now go to the same channel as welcome messages.';
  return { note: dialog.ok('Channel saved', msg), extraRow: row(undo.button), msg, undo };
}

function undoFor(ctx, label, restore) {
  const { engine, serverId } = ctx;
  return engine.router.addUndo({
    serverId, actorId: ctx.userId, label, perm: 'admin',
    run: async (i) => {
      await engine.perms.require(serverId, i?.user_id, 'admin');
      if (!engine.settings.isEnabled(serverId, ID)) throw friendly("Welcome isn't installed here anymore, so there is nothing to undo. An admin can install it with **/apps**.", { title: "Welcome isn't installed here" });
      engine.settings.patchApp(serverId, ID, restore);
      if ('autoroles' in restore) forgetLogged(engine, serverId, 'role:');
    },
  });
}

async function manageableRoles(ctx) {
  const all = await ctx.roles().catch(() => []);
  return all.filter((r) => !/^@?everyone$/i.test(r.name) && r.id !== ctx.serverId && !(r.auto && r.auto !== 'none'));
}

async function outranks(ctx, role) {
  if ((await ctx.level()) === 'owner') return true;
  if (typeof role?.position !== 'number') return true;
  return (await ctx.engine.perms.topPosition(ctx.serverId, ctx.userId)) > role.position;
}

async function extraPower(ctx, role) {
  if ((await ctx.level()) === 'owner') return null;
  const mine = await ctx.engine.perms.permsOf(ctx.serverId, ctx.userId).catch(() => ({}));
  if (mine.administrator) return null;
  return STAFF_PERMS.find((p) => role?.perms?.[p] && !mine[p]) || null;
}

async function roleProblem(ctx, id) {
  const r = await ctx.engine.perms.canManageRole(ctx.serverId, id);
  if (!r.ok) return r.reason;
  if (!(await outranks(ctx, r.role))) return `**${r.role.name}** is not below your own highest role, so you can't hand it out. Ask someone with a higher role.`;
  const power = await extraPower(ctx, r.role);
  if (power) return `**${r.role.name}** comes with **${permName(power)}**, which you don't have yourself, so you can't hand it to everyone who joins. Ask the server owner.`;
  return null;
}

async function checkRoles(ctx, ids) {
  const ok = [];
  const refused = [];
  for (const id of ids) {
    const problem = await roleProblem(ctx, id);
    if (problem) refused.push(problem);
    else ok.push(id);
  }
  return { ok, refused };
}

async function saveRoles(ctx, ids) {
  const prev = [...(ctx.config().autoroles || [])];
  const wanted = [...new Set(ids)];
  const { ok, refused } = await checkRoles(ctx, wanted.filter((id) => !prev.includes(id)));
  const allowed = wanted.filter((id) => prev.includes(id) || ok.includes(id));
  const kept = allowed.slice(0, MAX_AUTOROLES);
  if (allowed.length > MAX_AUTOROLES) refused.push(`Only ${MAX_AUTOROLES} starter roles fit. I kept the first ${MAX_AUTOROLES}.`);
  ctx.patchConfig({ autoroles: kept });
  forgetLogged(ctx.engine, ctx.serverId, 'role:');
  const undo = undoFor(ctx, 'starter roles', { autoroles: prev });
  const names = await roleNames(ctx, kept);
  const body = `${names.length ? `New members get ${names.map((n) => `**${n}**`).join(', ')}.` : 'No starter roles.'}${refused.length ? `\n\nSkipped:\n${refused.map((r) => `• ${r}`).join('\n')}` : ''}`;
  const note = refused.length ? dialog.warn('Starter roles saved, with a catch', body) : dialog.ok('Starter roles saved', body);
  return { note, undo, kept, refused };
}

async function rolePicker(ctx, note) {
  const roles = (await manageableRoles(ctx)).slice(0, 25);
  const current = new Set(ctx.config().autoroles || []);
  const intro = note || dialog.info('Starter roles', `Pick up to ${MAX_AUTOROLES} roles new members get when they join.\n-# You can also type \`/welcome autorole add @role\`. My role has to be above them.`);
  const back = row(button('Back', cid('home'), 'secondary', '⬅️'), button('Clear all', cid('roleclear'), 'danger', '🗑️'));
  if (!roles.length) return show(ctx, { embeds: [dialog.warn('No roles to pick', 'Make a role first, then come back.')], components: [back] });
  const opts = roles.map((r) => ({ label: r.name, value: r.id, default: current.has(r.id) }));
  const withSelect = { embeds: [intro], components: [select(cid('rolepick'), opts, { placeholder: 'Pick starter roles', min: 0, max: MAX_AUTOROLES }), back] };
  const btns = roles.slice(0, 15).map((r) => button(r.name, cid('role', r.id), current.has(r.id) ? 'success' : 'secondary', current.has(r.id) ? '✅' : undefined));
  const withButtons = { embeds: [intro], components: [...rows(btns).slice(0, 3), back] };
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => show(ctx, withSelect), () => show(ctx, withButtons));
}

async function openForm(ctx) {
  await ctx.require('admin');
  const cfg = ctx.config();
  return ctx.form({
    title: 'Welcome messages',
    action: 'save',
    fields: [
      { id: 'join', label: 'Join message', style: 'paragraph', value: cfg.joinText || DEFAULT_JOIN, max: 1000, placeholder: DEFAULT_JOIN },
      { id: 'leave', label: 'Leave message', style: 'paragraph', required: false, value: cfg.leaveText || DEFAULT_LEAVE, max: 1000 },
      { id: 'dm', label: 'Welcome DM', style: 'paragraph', required: false, value: cfg.dmText || DEFAULT_DM, max: 1000 },
      { id: 'title', label: 'Card title', style: 'short', required: false, value: cfg.cardTitle || DEFAULT_TITLE, max: 200 },
      { id: 'image', label: 'Card picture link (none to remove)', style: 'short', required: false, value: cfg.imageUrl || '', placeholder: 'https://i.imgur.com/abc.png', max: 512 },
    ],
  });
}

async function saveForm(ctx) {
  await ctx.require('admin');
  const v = ctx.values || {};
  const cfg = ctx.config();
  const prev = { joinText: cfg.joinText, leaveText: cfg.leaveText, dmText: cfg.dmText, cardTitle: cfg.cardTitle, imageUrl: cfg.imageUrl ?? null };
  const patch = {};
  const text = (k) => String(v[k] ?? '').trim();
  if (text('join')) patch.joinText = clip(text('join'), 1000);
  if (text('leave')) patch.leaveText = clip(text('leave'), 1000);
  if (text('dm')) patch.dmText = clip(text('dm'), 1000);
  if (text('title')) patch.cardTitle = clip(text('title'), 200);
  for (const key of ['joinText', 'leaveText', 'dmText', 'cardTitle']) {
    const problem = placeholderProblem(patch[key]);
    if (problem) return ctx.warn('Nothing saved yet', `${problem}\nFix it and save again.`, { components: [row(button('Edit messages', cid('edit'), 'primary', '📝'))] });
  }
  let refused = null;
  const img = text('image');
  const fromChat = !ctx.source?.custom_id;
  if (!img) { if (!fromChat) patch.imageUrl = null; }
  else if (/^(none|off|remove|clear)$/i.test(img)) patch.imageUrl = null;
  else {
    const check = checkImage(img);
    if (check.ok) patch.imageUrl = check.url;
    else refused = check.reason;
  }
  ctx.patchConfig(patch);
  const undo = undoFor(ctx, 'welcome messages', prev);
  const components = [row(undo.button, button('Preview', cid('preview'), 'secondary', '👀'))];
  if (refused) return ctx.warn('Saved, but not the picture', `Your messages are saved. I left the picture out: ${refused}`, { components });
  return ctx.ok('Welcome messages saved', 'New members will see the new text. Press **Preview** to check it.', { components });
}

async function testJoin(ctx) {
  await ctx.require('admin');
  const { engine } = ctx;
  const cfg = ctx.config();
  const ch = await joinChannel(engine, ctx.serverId, cfg);
  if (!ch) return ctx.warn('No channel yet', 'Pick a welcome channel first.');
  await ctx.ok('Sending a test', `Posting a welcome in <#${ch.id}> as if you just joined.${cfg.join ? '' : '\n-# Join messages are off, so real joins stay quiet until you turn them on.'}`);
  const [server, count] = await Promise.all([serverName(engine, ctx.serverId), memberCount(engine, ctx.serverId)]);
  const v = vars({ userId: ctx.userId, username: ctx.username, server, count });
  try {
    await ctx.send(ch.id, joinMessage(cfg, v), { priority: 'normal' });
  } catch (e) {
    const { title, body } = explain(e, { action: 'post in', target: `#${ch.name}`, perm: 'send_messages' });
    await ctx.error(title, body).catch(() => {});
  }
}

const SUBS = {
  channel: ['channel', 'chan', 'where', 'in'],
  join: ['join', 'joins', 'welcome', 'greet'],
  on: ['on', 'enable', 'start'],
  off: ['off', 'disable', 'stop'],
  leave: ['leave', 'goodbye', 'bye', 'leaves', 'farewell'],
  card: ['card', 'embed'],
  dm: ['dm', 'dms', 'pm'],
  text: ['text', 'message', 'msg', 'say'],
  image: ['image', 'picture', 'pic', 'thumbnail', 'img'],
  title: ['title'],
  autorole: ['autorole', 'autoroles', 'role', 'roles', 'starter'],
  edit: ['edit', 'form', 'messages'],
  preview: ['preview', 'show', 'look', 'see'],
  test: ['test', 'try'],
};
const ALIASES = Object.entries(SUBS).flatMap(([k, ws]) => ws.map((w) => [w, k]));

function subOf(word) {
  const w = String(word || '').toLowerCase();
  const exact = ALIASES.find(([a]) => a === w);
  if (exact) return { sub: exact[1] };
  if (w.length >= 4) {
    const close = ALIASES.map(([a, k]) => ({ a, k, d: levenshtein(a, w) })).filter((x) => x.d <= 1).sort((x, y) => x.d - y.d)[0];
    if (close) return { sub: close.k };
  }
  return { sub: null, guess: didYouMean(w, ALIASES.map(([a]) => a)) };
}

const looksLikeChannel = (t) => /^<#[\w-]+>$/.test(t) || /^#\S/.test(t);

async function typedChannel(ctx, which, tokens) {
  const token = tokens.join(' ').trim();
  if (!token) return channelPicker(ctx, which);
  if (which === 'leave' && /^(same|reset|default)$/i.test(token)) {
    const res = await setChannel(ctx, 'leave', null);
    return ctx.ok('Channel saved', res.msg, { components: [row(res.undo.button)] });
  }
  const ch = resolveChannel(token, await textChannels(ctx.engine, ctx.serverId));
  if (!ch) return ctx.warn("I can't find that channel", `No text channel matches **${clip(token, 50)}**. Try \`/welcome channel #general\`.`);
  const res = await setChannel(ctx, which, ch);
  return ctx.ok('Channel saved', res.msg, { components: [row(res.undo.button)] });
}

async function setFlag(ctx, key, value, label) {
  ctx.patchConfig({ [key]: value });
  const extra = key === 'dm' && value ? "\n-# DMs from bots are a testing feature on Yapin'. If they don't work here, I'll pause them and show it in **/welcome**." : '';
  return ctx.ok(`${label} ${value ? 'on' : 'off'}`, `${label} ${value ? 'are now on' : 'are now off'}.${extra}`);
}

const EMPTY_TEXT = 'Type the message after the command, like `/welcome text Welcome {user}!`.';

function checkText(text, max = 1000) {
  const t = String(text ?? '').trim();
  if (!t) return { title: 'What should it say?', error: EMPTY_TEXT };
  const problem = placeholderProblem(t);
  if (problem) return { title: 'Nothing saved yet', error: problem };
  return { value: clip(t, max) };
}

async function setText(ctx, key, text, label) {
  const checked = checkText(text);
  if (checked.error) return ctx.warn(checked.title, checked.error);
  const prev = ctx.config()[key];
  ctx.patchConfig({ [key]: checked.value });
  const undo = undoFor(ctx, label.toLowerCase(), { [key]: prev });
  return ctx.ok(`${label} saved`, `It now says:\n${checked.value}`, { components: [row(undo.button, button('Preview', cid('preview'), 'secondary', '👀'))] });
}

async function typedAutorole(ctx, tokens) {
  const verbs = { add: 'add', give: 'add', remove: 'remove', del: 'remove', delete: 'remove', rm: 'remove', clear: 'clear', none: 'clear', list: 'list', show: 'list' };
  let verb = verbs[(tokens[0] || '').toLowerCase()];
  const rest = verb ? tokens.slice(1) : tokens;
  if (!verb) verb = rest.length ? 'add' : 'list';
  const cur = [...(ctx.config().autoroles || [])];
  if (verb === 'list') return rolePicker(ctx);
  if (verb === 'clear') {
    const res = await saveRoles(ctx, []);
    return ctx.ok('Starter roles cleared', 'New members no longer get roles when they join.', { components: [row(res.undo.button)] });
  }
  const token = rest.join(' ');
  const role = resolveRole(token, await manageableRoles(ctx));
  if (!role) return ctx.warn("I can't find that role", `No role matches **${clip(token || '?', 50)}**. Try \`/welcome autorole add @Member\`.`);
  if (verb === 'remove') {
    const res = await saveRoles(ctx, cur.filter((id) => id !== role.id));
    return ctx.ok('Starter role removed', `New members won't get **${role.name}** anymore.`, { components: [row(res.undo.button)] });
  }
  if (cur.includes(role.id)) return ctx.info('Already there', `New members already get **${role.name}**.`);
  if (cur.length >= MAX_AUTOROLES) return ctx.warn('That is the limit', `You can have up to ${MAX_AUTOROLES} starter roles. Remove one first.`);
  const problem = await roleProblem(ctx, role.id);
  if (problem) return ctx.warn(`I can't give out ${role.name}`, problem);
  const res = await saveRoles(ctx, [...cur, role.id]);
  return ctx.ok('Starter role added', `New members now get **${role.name}** when they join.`, { components: [row(res.undo.button)] });
}

async function typedImage(ctx, tokens) {
  const url = tokens.join(' ').trim();
  if (!url || /^(none|off|remove|clear)$/i.test(url)) {
    const prev = ctx.config().imageUrl ?? null;
    ctx.patchConfig({ imageUrl: null });
    const undo = undoFor(ctx, 'card picture', { imageUrl: prev });
    return ctx.ok('Picture removed', 'Welcome cards have no picture now.', { components: [row(undo.button)] });
  }
  const check = checkImage(url);
  if (!check.ok) return ctx.warn("I can't use that picture", check.reason);
  const prev = ctx.config().imageUrl ?? null;
  ctx.patchConfig({ imageUrl: check.url, card: true });
  const undo = undoFor(ctx, 'card picture', { imageUrl: prev });
  return ctx.ok('Picture saved', 'Welcome cards now show that picture.', { components: [row(undo.button)] });
}

function skipTokens(raw, n) {
  const s = String(raw ?? '');
  const re = /\s*(?:"[^"]*"|'[^']*'|“[^”]*”|\S+)/y;
  for (let i = 0; i < n; i++) if (!re.exec(s)) return '';
  return s.slice(re.lastIndex).trim();
}

async function runArgs(ctx, tokens, raw) {
  if (!ctx.serverId) return ctx.warn('Servers only', 'Welcome settings live in a server. Run **/welcome** there.');
  if (!tokens.length) return openPanel(ctx);
  const [first, ...rest] = tokens;
  if (looksLikeChannel(first)) { await ctx.require('admin'); return typedChannel(ctx, 'join', tokens); }
  const { sub, guess } = subOf(first);
  if (sub === 'preview') return ctx.ephemeral(await previewView(ctx));
  await ctx.require('admin');
  const bool = parseBool(rest[0]);
  const restText = () => (typeof raw === 'string' ? skipTokens(raw, 1) : tokens.slice(1).join(' '));
  switch (sub) {
    case 'channel':
      if (SUBS.leave.includes((rest[0] || '').toLowerCase())) return typedChannel(ctx, 'leave', rest.slice(1));
      return typedChannel(ctx, 'join', rest);
    case 'on': return setFlag(ctx, 'join', true, 'Join messages');
    case 'off': return setFlag(ctx, 'join', false, 'Join messages');
    case 'join':
      if (bool !== null) return setFlag(ctx, 'join', bool, 'Join messages');
      if (!rest.length) return openPanel(ctx);
      return setText(ctx, 'joinText', restText(), 'Join message');
    case 'leave':
      if (bool !== null) return setFlag(ctx, 'leave', bool, 'Leave messages');
      if (!rest.length) return openPanel(ctx);
      if (SUBS.channel.includes(rest[0].toLowerCase())) return typedChannel(ctx, 'leave', rest.slice(1));
      if (looksLikeChannel(rest[0])) return typedChannel(ctx, 'leave', rest);
      return setText(ctx, 'leaveText', restText(), 'Leave message');
    case 'card':
      if (bool === null) return ctx.warn('On or off?', 'Try `/welcome card on` or `/welcome card off`.');
      return setFlag(ctx, 'card', bool, 'Welcome cards');
    case 'dm':
      if (bool !== null) return setFlag(ctx, 'dm', bool, 'Welcome DMs');
      if (!rest.length) return ctx.warn('On or off?', 'Try `/welcome dm on`, or `/welcome dm Hi {username}!` to change the text.');
      return setText(ctx, 'dmText', restText(), 'Welcome DM');
    case 'text': return setText(ctx, 'joinText', restText(), 'Join message');
    case 'title': return setText(ctx, 'cardTitle', restText(), 'Card title');
    case 'image': return typedImage(ctx, rest);
    case 'autorole': return typedAutorole(ctx, rest);
    case 'edit': return openForm(ctx);
    case 'test': return testJoin(ctx);
    default:
      return ctx.warn("I didn't get that", `I don't know **${clip(first, 30)}**.${guess?.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/welcome\` for the panel, or \`/welcome channel #hi\`, \`/welcome text Hi {user}!\`, \`/welcome autorole add @Member\`, \`/welcome preview\`.`);
  }
}

const TOGGLES = { join: 'join', leave: 'leave', card: 'card', dm: 'dm' };
const IMAGE_OFF = /^(none|off|remove|clear)$/i;

const textField = (key, label, help, max = 1000, type = 'text') => ({
  key, label, help, type, web: true, maxLength: max,
  validate: (ctx, v) => {
    const checked = checkText(typeof v === 'string' ? v : '', max);
    return checked.error ? reject(checked.error) : accept(checked.value);
  },
});

const channelField = (key, label, help, which) => ({
  key, label, help, type: 'channel', web: true,
  validate: async (ctx, v) => {
    if (which === 'leave' && (isBlank(v) || /^(same|reset|default)$/i.test(String(v).trim()))) return accept(null);
    const id = safeId(v);
    const ch = id ? (await textChannels(ctx.engine, ctx.serverId)).find((c) => c.id === id) : null;
    return ch ? accept(ch.id) : reject(`No text channel matches **${clip(String(v ?? '?'), 50)}**. Try \`/welcome channel #general\`.`);
  },
  save: (ctx, value) => {
    ctx.patchConfig({ [key]: value });
    forgetLogged(ctx.engine, ctx.serverId, 'send');
  },
});

async function validateAutoroles(ctx, v) {
  const ids = idList(v);
  if (!ids) return reject('Pick roles from the list.');
  const wanted = [...new Set(ids)];
  if (wanted.length > MAX_AUTOROLES) return reject(`You can have up to ${MAX_AUTOROLES} starter roles. Remove one first.`);
  const prev = ctx.config().autoroles || [];
  const candidates = await manageableRoles(ctx);
  for (const id of wanted) {
    if (prev.includes(id)) continue;
    const role = candidates.find((r) => r.id === id);
    if (!role) return reject(`No role matches **${clip(id, 50)}**. Try \`/welcome autorole add @Member\`.`);
    const problem = await roleProblem(ctx, id);
    if (problem) return reject(problem);
  }
  return accept(wanted);
}

const DASHBOARD = [
  boolField({ key: 'join', label: 'Join messages', help: 'Posts a welcome message when someone joins.' }),
  boolField({ key: 'leave', label: 'Leave messages', help: 'Posts a goodbye message when someone leaves.' }),
  boolField({ key: 'card', label: 'Welcome card', help: 'Sends the join message as an embed card instead of plain text.' }),
  boolField({ key: 'dm', label: 'Welcome DM', help: "Also DMs new members. DMs from bots are a testing feature on Yapin'." }),
  channelField('channel', 'Welcome channel', 'Where join messages go.', 'join'),
  channelField('leaveChannel', 'Goodbye channel', 'Where leave messages go. Empty means the same channel as join messages.', 'leave'),
  textField('joinText', 'Join message', 'Placeholders: {user} {username} {server} {count} {count_ord}.'),
  textField('leaveText', 'Leave message', 'Same placeholders as the join message.'),
  textField('dmText', 'Welcome DM text', 'Same placeholders as the join message.'),
  textField('cardTitle', 'Card title', 'Title on the welcome card. Placeholders work here too.', 200, 'string'),
  {
    key: 'imageUrl', label: 'Card picture link', type: 'string', web: true, maxLength: 512,
    help: "Optional thumbnail on the welcome card. Must be an https link from a host Yapin' shows.",
    validate: (ctx, v) => {
      if (isBlank(v) || (typeof v === 'string' && IMAGE_OFF.test(v.trim()))) return accept(null);
      if (typeof v !== 'string') return reject("That doesn't look like a link. Paste a full picture link that starts with https://.");
      const check = checkImage(v);
      return check.ok ? accept(check.url) : reject(check.reason);
    },
    save: (ctx, value) => {
      if (value === null) { ctx.patchConfig({ imageUrl: null }); return { applied: { imageUrl: null } }; }
      ctx.patchConfig({ imageUrl: value, card: true });
      return { applied: { imageUrl: value, card: true } };
    },
  },
  {
    key: 'autoroles', label: 'Starter roles', type: 'roles', web: true, max: MAX_AUTOROLES,
    help: 'Up to 5 roles given to every new member when they join.',
    validate: validateAutoroles,
    save: (ctx, value) => {
      ctx.patchConfig({ autoroles: value });
      forgetLogged(ctx.engine, ctx.serverId, 'role:');
    },
  },
];

const adminOnly = (run) => ({
  perm: 'admin',
  run: async (ctx) => {
    await ctx.require('admin');
    return run(ctx);
  },
});

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Welcome',
  icon: '👋',
  description: 'Greets new members, says goodbye and gives starter roles.',
  category: 'Community',
  defaults: {
    join: true,
    leave: false,
    card: true,
    dm: false,
    channel: null,
    leaveChannel: null,
    joinText: DEFAULT_JOIN,
    leaveText: DEFAULT_LEAVE,
    dmText: DEFAULT_DM,
    cardTitle: DEFAULT_TITLE,
    imageUrl: null,
    autoroles: [],
  },

  commands: {
    welcome: {
      description: 'Welcome panel. Try /welcome channel #hi, /welcome text Hi {user}!, /welcome preview',
      run: (ctx) => runArgs(ctx, tokenize(ctx.args), ctx.args),
    },
  },

  components: {
    home: adminOnly(async (ctx) => ctx.update(await panelView(ctx))),
    toggle: adminOnly(async (ctx) => {
      const key = Object.hasOwn(TOGGLES, ctx.argv[0]) ? TOGGLES[ctx.argv[0]] : null;
      if (!key) return ctx.warn('Old button', 'Open **/welcome** again.');
      const on = !ctx.config()[key];
      ctx.patchConfig({ [key]: on });
      let note;
      if (key === 'dm' && on) note = dialog.info('Welcome DMs on', "DMs from bots are a testing feature on Yapin'. If they don't work here, I'll pause them and show it right here.");
      return ctx.update(await panelView(ctx, { note }));
    }),
    pick: adminOnly((ctx) => channelPicker(ctx, ctx.argv[0] === 'leave' ? 'leave' : 'join')),
    chanpick: adminOnly(async (ctx) => {
      const which = ctx.argv[0] === 'leave' ? 'leave' : 'join';
      const ch = (await textChannels(ctx.engine, ctx.serverId)).find((c) => c.id === ctx.values?.[0]);
      if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the picker again.');
      const res = await setChannel(ctx, which, ch);
      return ctx.update(await panelView(ctx, res));
    }),
    chan: adminOnly(async (ctx) => {
      const which = ctx.argv[0] === 'leave' ? 'leave' : 'join';
      const ch = (await textChannels(ctx.engine, ctx.serverId)).find((c) => c.id === ctx.argv[1]);
      if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the picker again.');
      const res = await setChannel(ctx, which, ch);
      return ctx.update(await panelView(ctx, res));
    }),
    chanreset: adminOnly(async (ctx) => ctx.update(await panelView(ctx, await setChannel(ctx, 'leave', null)))),
    roles: adminOnly((ctx) => rolePicker(ctx)),
    rolepick: adminOnly(async (ctx) => {
      const all = (await manageableRoles(ctx)).map((r) => r.id);
      const shown = new Set(all.slice(0, 25));
      const offList = (ctx.config().autoroles || []).filter((id) => all.includes(id) && !shown.has(id));
      const res = await saveRoles(ctx, [...offList, ...(ctx.values || []).map(String)]);
      return ctx.update(await panelView(ctx, { note: res.note, extraRow: row(res.undo.button) }));
    }),
    role: adminOnly(async (ctx) => {
      const id = ctx.argv[0];
      const cur = [...(ctx.config().autoroles || [])];
      const next = cur.includes(id) ? cur.filter((r) => r !== id) : [...cur, id];
      if (next.length > MAX_AUTOROLES) return ctx.warn('That is the limit', `You can have up to ${MAX_AUTOROLES} starter roles. Turn one off first.`);
      const res = await saveRoles(ctx, next);
      return rolePicker(ctx, res.note);
    }),
    roleclear: adminOnly(async (ctx) => {
      const res = await saveRoles(ctx, []);
      return ctx.update(await panelView(ctx, { note: dialog.ok('Starter roles cleared', 'New members no longer get roles when they join.'), extraRow: row(res.undo.button) }));
    }),
    edit: adminOnly((ctx) => openForm(ctx)),
    save: adminOnly(saveForm),
    preview: {
      run: async (ctx) => {
        if (!ctx.serverId) return ctx.warn('Servers only', 'Run **/welcome preview** in a server.');
        return ctx.ephemeral(await previewView(ctx));
      },
    },
    test: adminOnly(testJoin),
  },

  events: {
    member_join: onJoin,
    member_leave: onLeave,
  },

  yap: [
    { words: ['welcome', 'greet'], run: (ctx) => runArgs(ctx, ctx.argv, ctx.args) },
    { words: ['goodbye'], run: (ctx) => (ctx.argv.length ? runArgs(ctx, ['leave', ...ctx.argv], `leave ${ctx.args}`) : runArgs(ctx, ['preview'])) },
    { words: ['autorole'], run: (ctx) => runArgs(ctx, ['autorole', ...ctx.argv]) },
  ],

  panel: openPanel,

  dashboard: DASHBOARD,

  services: (engine) => ({
    flushBursts: (sid) => flushBurst(engine, sid),
    flushLate: (sid) => flushLate(engine, sid),
    checkImage,
    pending: (sid) => runtime(engine).bursts.get(sid)?.total || 0,
  }),

  presets: PRESETS,

  applyPreset: async (engine, serverId, { preset, channels } = {}) => {
    const p = PRESETS[preset] || PRESETS.community;
    const ch = channels?.welcome || channels?.general || null;
    engine.settings.patchApp(serverId, ID, { ...p.config, channel: ch?.id ?? null });
    const parts = [ch ? `greets new members in #${ch.name}` : 'pick a welcome channel with /welcome'];
    if (p.config.leave) parts.push('says goodbye');
    return `👋 Welcome: ${parts.join(', ')}.`;
  },

  help: [
    '`/welcome channel #hi` picks where welcome messages go. `/welcome leave on` turns on goodbyes.',
    '`/welcome text Welcome {user}!` changes the join message. Words: {user} {username} {server} {count} {count_ord}.',
    '`/welcome autorole add @Member` gives up to 5 starter roles. `/welcome preview` shows how it looks.',
    'During a raid (more than 10 joins in 30 seconds) I post one combined welcome instead of many.',
  ],

  dispose(engine) {
    const { bursts, logged, late } = runtime(engine);
    for (const b of bursts.values()) if (b.timer) clearTimeout(b.timer);
    for (const b of late.values()) if (b.timer) clearTimeout(b.timer);
    bursts.clear();
    late.clear();
    logged.clear();
  },
});
