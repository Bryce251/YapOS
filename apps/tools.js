import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS, COLORS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, fillTemplate, clip, parseDuration, formatDuration } from '../engine/parse.js';
import { friendly } from '../engine/errors.js';
import { isTimeZone, partsAt, zonedTime } from '../engine/scheduler.js';

const ID = 'tools';
const cid = (action, ...args) => customId(ID, action, ...args);
const POST_KIND = `${ID}.post`;

const TAG_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_TAGS = 200;
const MAX_TAG_TEXT = 2000;
const TAG_COOLDOWN_MS = 3000;
const SUGGEST_COOLDOWN_MS = 30_000;
const SEND_GUARD_MS = 5000;
const TAGS_PER_PAGE = 15;
const RESERVED_TAGS = new Set(['add', 'create', 'new', 'edit', 'update', 'delete', 'remove', 'del', 'rm', 'list', 'all', 'info', 'help']);

const MAX_DRAFTS = 5;
const MAX_TITLE = 256;
const MAX_TEXT = 4000;
const MAX_FOOTER = 200;
const MAX_IMAGE = 512;
const PREVIEW_TTL_MS = 30 * 60_000;

const MAX_POSTS = 50;
const MAX_POST_TEXT = 2000;
const MIN_REPEAT_MS = 3600_000;
const MAX_AHEAD_MS = 2 * 365 * 86_400_000;
const MIN_AHEAD_MS = 60_000;
const LATE_SKIP_MS = 3600_000;
const POSTS_WITH_BUTTONS = 10;

const COOLDOWN_LIMIT = 5000;

const IMAGE_HOSTS = new Set([
  'i.imgur.com', 'media.tenor.com', 'media.giphy.com', 'i.giphy.com', 'upload.wikimedia.org',
  'raw.githubusercontent.com', 'avatars.githubusercontent.com', 'user-images.githubusercontent.com',
  'i.ytimg.com', 'cdn.discordapp.com', 'media.discordapp.net', 'pbs.twimg.com', 'i.redd.it',
  'static-cdn.jtvnw.net', 'i.scdn.co', 's4.anilist.co', 'cdn.myanimelist.net', 'nekos.best', 'cdn.weeb.sh',
]);
const IMAGE_HOST_SUFFIXES = ['klipy.com', 'rbxcdn.com', 'yapin.gg', 'yapper.website'];

const SWATCHES = [
  { name: 'Teal', hex: '1abc9c', emoji: '🟢' },
  { name: 'Blue', hex: '3498db', emoji: '🔵' },
  { name: 'Purple', hex: '9b59b6', emoji: '🟣' },
  { name: 'Pink', hex: 'eb459e', emoji: '🩷' },
  { name: 'Red', hex: 'ed4245', emoji: '🔴' },
  { name: 'Orange', hex: 'e67e22', emoji: '🟠' },
  { name: 'Yellow', hex: 'fee75c', emoji: '🟡' },
  { name: 'Green', hex: '57f287', emoji: '💚' },
  { name: 'Grey', hex: '95a5a6', emoji: '⚪' },
  { name: 'Black', hex: '23272a', emoji: '⚫' },
];
const COLOUR_NAMES = {
  teal: '1abc9c', blue: '3498db', purple: '9b59b6', violet: '9b59b6', pink: 'eb459e', red: 'ed4245', orange: 'e67e22',
  yellow: 'fee75c', gold: 'f1c40f', green: '57f287', grey: '95a5a6', gray: '95a5a6', black: '23272a', white: 'ffffff',
  brand: '7c5cff', default: '1abc9c', blurple: '5865f2',
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { cooldowns: new Map(), editing: new Map() };
    states.set(engine, s);
  }
  return s;
}

const readDoc = (engine, sid) => {
  const d = engine.store.get(ID, sid, {}) || {};
  d.tags ||= {};
  d.drafts ||= {};
  d.posts ||= {};
  return d;
};

function write(engine, sid, fn) {
  let out;
  engine.store.update(ID, sid, (d) => {
    d ||= {};
    d.tags ||= {};
    d.drafts ||= {};
    d.posts ||= {};
    out = fn(d);
    return d;
  }, {});
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const plainName = (name) => String(name ?? '').replace(/[<>]/g, '').replace(/@/g, '@​');
const mdSafe = (text, max = 40) => clip(plainName(text).replace(/[*_`~|\\]/g, '').replace(/\s+/g, ' ').trim(), max);
const isAdminLevel = (engine, level) => engine.perms.atLeast(level, 'admin');
const onMessage = (ctx) => !!ctx.source?.message_id && typeof ctx.source.update === 'function';

function cursorOf(text) {
  const s = String(text ?? '');
  const toks = [...s.matchAll(/\S+/g)].map((m) => ({ t: m[0], at: m.index }));
  let i = 0;
  return {
    peek: (k = 0) => toks[i + k]?.t ?? null,
    take: () => toks[i++]?.t ?? null,
    skip: (n = 1) => { i += n; },
    rest: () => (i < toks.length ? s.slice(toks[i].at).trim() : ''),
    mark: () => i,
    reset: (k) => { i = k; },
  };
}

function shortAgo(ms) {
  const d = Math.max(0, Date.now() - (Number(ms) || 0));
  if (d < 60_000) return 'just now';
  return `${formatDuration(d)} ago`;
}

function untilText(ms) {
  const d = Math.max(0, ms);
  if (d < 60_000) return 'in under a minute';
  const days = Math.floor(d / 86_400_000);
  const hours = Math.floor((d % 86_400_000) / 3_600_000);
  const mins = Math.floor((d % 3_600_000) / 60_000);
  if (days) return `in ${days} d${hours ? ` ${hours} h` : ''}`;
  if (hours) return `in ${hours} h${mins ? ` ${mins} min` : ''}`;
  return `in ${mins} min`;
}

const tzLabel = (tz) => (tz === 'UTC' || tz === 'Etc/UTC' ? 'UTC' : tz);

function whenText(ms, tz, nowMs) {
  const zone = isTimeZone(tz) ? tz : 'UTC';
  const sameYear = partsAt(ms, zone).y === partsAt(nowMs ?? ms, zone).y;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${f.format(new Date(ms))} ${tzLabel(zone)}`;
}

function canonicalZone(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (/^(utc|gmt|z)$/i.test(t)) return 'UTC';
  if (!isTimeZone(t)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: t }).resolvedOptions().timeZone; } catch { return null; }
}

function serverZone(engine, sid) {
  return canonicalZone(engine.settings.core(sid).timezone) || 'UTC';
}

async function logProblem(engine, sid, title, text) {
  const embed = card({ title: `${ICONS.tools} ${title}`, body: text, color: 'tools' });
  try {
    const mod = engine.service('mod');
    if (mod?.log) { await mod.log(sid, embed); return; }
  } catch (e) {
    engine.log.debug('[tools] mod log failed', e?.message);
  }
  const ch = engine.settings.core(sid).logChannel;
  if (!ch) { engine.log.warn(`[tools] ${title}: ${text}`); return; }
  await engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low' }).catch((e) => engine.log.debug('[tools] log failed', e?.message));
}

function adminUndo(ctx, label, revert, manual) {
  const { engine, serverId: sid } = ctx;
  return engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label, perm: 'admin', manual,
    run: async (i) => {
      if (i?.server_id && i.server_id !== sid) throw friendly('That Undo button belongs to another server, so it does nothing here.', { title: 'Wrong server' });
      return revert(i);
    },
  });
}

function modUndo(ctx, label, revert, manual) {
  const { engine, serverId: sid } = ctx;
  return engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label, perm: 'mod', manual,
    run: async (i) => {
      if (i?.server_id && i.server_id !== sid) throw friendly('That Undo button belongs to another server, so it does nothing here.', { title: 'Wrong server' });
      return revert(i);
    },
  });
}

const cleanTagName = (raw) => String(raw ?? '').trim().replace(/^!+/, '').toLowerCase();

function tagNameProblem(ctx, name) {
  if (!name) return 'Give the tag a name, like `/tag add rules Be nice to everyone`.';
  if (!TAG_NAME_RE.test(name)) return 'Tag names are 1 to 32 characters: lowercase letters, numbers, `-` and `_`. No spaces.';
  if (RESERVED_TAGS.has(name)) return `**${name}** is a word /tag uses itself. Pick another name.`;
  if (ctx.bot.commands?.has?.(name)) return `**!${name}** is already a YapOS command, so a tag with that name would never show up. Pick another name.`;
  return null;
}

async function renderTag(ctx, tag) {
  const server = await ctx.engine.perms.server(ctx.serverId).catch(() => null);
  const filled = fillTemplate(tag.text, {
    user: `<@${ctx.userId}>`,
    username: plainName(ctx.username),
    server: plainName(server?.name || 'this server'),
    channel: ctx.channelId ? `<#${ctx.channelId}>` : '',
  });
  let roles = null;
  const withRoles = await (async () => {
    if (!/<@&[\w-]+>/.test(filled)) return filled;
    roles = await ctx.roles().catch(() => []);
    return filled.replace(/<@&([\w-]+)>/g, (all, id) => {
      const r = roles.find((x) => x.id === id);
      return r ? `**@${mdSafe(r.name, 60)}**` : '**@deleted role**';
    });
  })();
  return clip(withRoles.replace(/@(everyone|here)/gi, '@​$1'), MAX_TAG_TEXT);
}

function onCooldown(engine, sid, uid, name, ms = TAG_COOLDOWN_MS) {
  const st = stateOf(engine);
  const key = `${sid}:${uid}:${name}`;
  const now = Date.now();
  const until = st.cooldowns.get(key);
  if (until !== undefined && now < until) return true;
  if (st.cooldowns.size >= COOLDOWN_LIMIT) {
    for (const [k, t] of st.cooldowns) if (now >= t) st.cooldowns.delete(k);
    if (st.cooldowns.size >= COOLDOWN_LIMIT) st.cooldowns.clear();
  }
  st.cooldowns.set(key, now + ms);
  return false;
}

const canPing = (r, sid) => !!r && r.mentionable && !(r.auto && r.auto !== 'none') && !/^@?everyone$/i.test(r.name) && r.id !== sid && r.id !== 'everyone';

async function safeMentions(engine, sid, text) {
  let out = String(text ?? '').replace(/@(everyone|here)/gi, '@​$1');
  if (!/<@&[\w-]+>/.test(out)) return out;
  const roles = await engine.perms.roles(sid).catch(() => []);
  out = out.replace(/<@&([\w-]+)>/g, (all, id) => {
    const r = roles.find((x) => x.id === id);
    if (!r) return '**@deleted role**';
    return canPing(r, sid) ? all : `**@${mdSafe(r.name, 60)}**`;
  });
  return out;
}

function countUse(engine, sid, name) {
  write(engine, sid, (d) => {
    const t = d.tags[name];
    if (!t) return;
    t.uses = (Number(t.uses) || 0) + 1;
    t.lastUsedAt = Date.now();
  });
}

function suggestionText(names, asked) {
  const guess = didYouMean(asked, names);
  return guess.length ? `Did you mean ${guess.map((g) => `**!${g}**`).join(', ')}?` : '';
}

async function useTag(ctx, rawName) {
  const name = cleanTagName(rawName);
  const tags = readDoc(ctx.engine, ctx.serverId).tags;
  const tag = TAG_NAME_RE.test(name) ? tags[name] : null;
  if (!tag) {
    const hint = suggestionText(Object.keys(tags), name);
    const shown = TAG_NAME_RE.test(name) ? `**!${name}**` : 'that name';
    return ctx.warn('No such tag', `There's no tag called ${shown}.${hint ? ` ${hint}` : ''}\n-# See every tag with **/tag list**.`);
  }
  if (onCooldown(ctx.engine, ctx.serverId, ctx.userId, name)) return ctx.info('Slow down a little', `You just used **!${name}**. Give it a few seconds.`);
  const text = await renderTag(ctx, tag);
  countUse(ctx.engine, ctx.serverId, name);
  return ctx.reply(text);
}

async function onChatTag(ctx, msg) {
  const { engine } = ctx;
  const sid = msg.server_id;
  if (!sid || msg.dm || msg.is_dm || msg.yaposLate || msg.author_bot || msg.command) return;
  const uid = msg.author_id;
  if (!uid || uid === engine.bot.me?.id) return;
  const m = /^!([a-z0-9_-]{1,32})(?=\s|$)/i.exec(String(msg.content || '').trim());
  if (!m) return;
  const name = m[1].toLowerCase();
  if (engine.bot.commands?.has?.(name)) return;
  const tags = readDoc(engine, sid).tags;
  const tag = tags[name];
  if (!tag) {
    const names = Object.keys(tags);
    if (!names.length) return;
    const guess = didYouMean(name, names, { max: 2 });
    if (!guess.length) return;
    if (onCooldown(engine, sid, uid, '?suggest', SUGGEST_COOLDOWN_MS)) return;
    await ctx.warn('No such tag', `There's no tag called **!${name}**. Did you mean ${guess.map((g) => `**!${g}**`).join(', ')}?`);
    return;
  }
  if (onCooldown(engine, sid, uid, name)) return;
  const text = await renderTag(ctx, tag);
  countUse(engine, sid, name);
  await ctx.reply(text);
}

function tagListView(engine, sid, page, { isMod = false } = {}) {
  const tags = Object.values(readDoc(engine, sid).tags).sort((a, b) => a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(tags.length / TAGS_PER_PAGE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const slice = tags.slice((p - 1) * TAGS_PER_PAGE, p * TAGS_PER_PAGE);
  const lines = slice.map((t) => `**!${t.name}** · ${mdSafe(t.text.replace(/\{\w+\}/g, '…'), 50) || '…'}`);
  const empty = isMod ? 'No tags yet. Add one with `/tag add rules Be nice to everyone`.' : 'No tags yet. Ask a moderator to add some.';
  const body = lines.length ? `${lines.join('\n')}\n\n-# Type **!name** in chat or **/tag name** to post one.` : empty;
  const buttons = [];
  if (pages > 1) {
    buttons.push(button('Prev', cid('tlist', p - 1), 'secondary', '⬅️', { disabled: p <= 1 }));
    buttons.push(button('Next', cid('tlist', p + 1), 'secondary', '➡️', { disabled: p >= pages }));
  }
  return {
    embeds: [card({ title: `🏷️ Tags (${tags.length})`, body, color: 'tools', footer: `Page ${p} of ${pages}` })],
    components: buttons.length ? [row(buttons)] : [],
  };
}

async function showTagList(ctx, page) {
  const isMod = ctx.engine.perms.atLeast(await ctx.level(), 'mod');
  const view = tagListView(ctx.engine, ctx.serverId, page, { isMod });
  if (!view.components.length) return ctx.ephemeral({ embeds: view.embeds });
  return ctx.ephemeral(view);
}

function saveTag(ctx, name, text, { editing = false } = {}) {
  const { engine, serverId: sid } = ctx;
  return write(engine, sid, (d) => {
    const cur = d.tags[name];
    if (editing) {
      if (!cur) return { error: 'missing' };
      const before = { ...cur };
      cur.text = text;
      cur.updatedAt = Date.now();
      cur.updatedBy = ctx.userId;
      return { before };
    }
    if (cur) return { error: 'exists' };
    if (Object.keys(d.tags).length >= MAX_TAGS) return { error: 'full' };
    d.tags[name] = { name, text, authorId: ctx.userId, createdAt: Date.now(), updatedAt: null, updatedBy: null, uses: 0, lastUsedAt: null };
    return {};
  });
}

async function addTag(ctx, name, text, { editing = false } = {}) {
  await ctx.require('mod');
  const problem = tagNameProblem(ctx, name);
  if (problem && !(editing && TAG_NAME_RE.test(name))) return ctx.warn("That tag name doesn't work", problem);
  const body = String(text ?? '').trim();
  if (!body) return ctx.warn('What should the tag say?', `Try \`/tag ${editing ? 'edit' : 'add'} ${name} Be nice to everyone\`.`);
  if (body.length > MAX_TAG_TEXT) return ctx.warn('That tag is too long', `Tags can be up to ${MAX_TAG_TEXT} characters. This one is ${body.length}.`);
  const res = saveTag(ctx, name, body, { editing });
  const sid = ctx.serverId;
  const engine = ctx.engine;
  if (res.error === 'exists') return ctx.warn('That tag already exists', `**!${name}** is taken. Change it with \`/tag edit ${name} new text\`.`);
  if (res.error === 'full') return ctx.warn('Too many tags', `This server has ${MAX_TAGS} tags, the most I keep. Delete one with \`/tag delete name\` first.`);
  if (res.error === 'missing') {
    const hint = suggestionText(Object.keys(readDoc(engine, sid).tags), name);
    return ctx.warn('No such tag', `There's no tag called **!${name}** to edit.${hint ? ` ${hint}` : ''}`);
  }
  const preview = clip(body, 300);
  if (editing) {
    const before = res.before;
    const undo = modUndo(ctx, `edit of !${name}`, async () => {
      write(engine, sid, (d) => { if (d.tags[name]) d.tags[name] = { ...d.tags[name], text: before.text, updatedAt: before.updatedAt, updatedBy: before.updatedBy }; });
    });
    return ctx.ok('Tag updated', `**!${name}** now says:\n${preview}`, { components: [row(undo.button)] });
  }
  return ctx.ok('Tag saved', `Anyone can post it with **!${name}** or **/tag ${name}**.\n${preview}\n-# {user} becomes the person using it, {server} the server name.`);
}

async function deleteTag(ctx, rawName) {
  await ctx.require('mod');
  const name = cleanTagName(rawName);
  const { engine, serverId: sid } = ctx;
  if (!name) return ctx.warn('Delete which tag?', 'Try `/tag delete rules`.');
  const removed = write(engine, sid, (d) => {
    const t = d.tags[name];
    if (!t) return null;
    delete d.tags[name];
    return t;
  });
  if (!removed) {
    const hint = suggestionText(Object.keys(readDoc(engine, sid).tags), name);
    return ctx.warn('No such tag', `There's no tag called **!${mdSafe(name, 32)}**.${hint ? ` ${hint}` : ''}`);
  }
  const undo = modUndo(ctx, `delete of !${name}`, async (i) => {
    const res = write(engine, sid, (d) => {
      if (d.tags[name]) return 'taken';
      if (Object.keys(d.tags).length >= MAX_TAGS) return 'full';
      d.tags[name] = removed;
      return 'ok';
    });
    if (res === 'ok') return true;
    await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring it back", res === 'taken' ? `Someone already made a new **!${name}**.` : `This server is at ${MAX_TAGS} tags.`)] });
    return false;
  });
  return ctx.ok('Tag deleted', `**!${name}** is gone (it was used ${plural(Number(removed.uses) || 0, 'time')}).`, { components: [row(undo.button)] });
}

async function tagInfo(ctx, rawName) {
  const name = cleanTagName(rawName);
  const tags = readDoc(ctx.engine, ctx.serverId).tags;
  const t = TAG_NAME_RE.test(name) ? tags[name] : null;
  if (!t) {
    const hint = suggestionText(Object.keys(tags), name);
    return ctx.warn('No such tag', `There's no tag called **!${mdSafe(name, 32) || '?'}**.${hint ? ` ${hint}` : ''}`);
  }
  const author = await ctx.engine.perms.member(ctx.serverId, t.authorId).catch(() => null);
  const who = author ? mdSafe(author.nickname || author.display_name || author.username, 40) : 'someone who left';
  const fields = [
    { name: 'Made by', value: who, inline: true },
    { name: 'Uses', value: String(Number(t.uses) || 0), inline: true },
    { name: 'Made', value: shortAgo(t.createdAt), inline: true },
    t.updatedAt ? { name: 'Last edited', value: shortAgo(t.updatedAt), inline: true } : null,
    t.lastUsedAt ? { name: 'Last used', value: shortAgo(t.lastUsedAt), inline: true } : null,
  ];
  return ctx.ephemeral({ embeds: [card({ title: `🏷️ !${t.name}`, body: clip(t.text, 1500), fields, color: 'tools' })] });
}

async function tagForm(ctx, { name = '', editing = false } = {}) {
  await ctx.require('mod');
  const cur = editing ? readDoc(ctx.engine, ctx.serverId).tags[name] : null;
  if (editing && name && !cur) {
    const hint = suggestionText(Object.keys(readDoc(ctx.engine, ctx.serverId).tags), name);
    return ctx.warn('No such tag', `There's no tag called **!${mdSafe(name, 32)}** to edit.${hint ? ` ${hint}` : ''}`);
  }
  return ctx.form({
    title: editing ? 'Edit a tag' : 'New tag',
    action: editing ? 'tagedit' : 'tagsave',
    fields: [
      { id: 'name', label: 'Name (people type !name)', style: 'short', value: name, placeholder: 'rules', max: 32 },
      { id: 'text', label: 'What it says ({user} and {server} work)', style: 'paragraph', value: cur?.text || '', max: MAX_TAG_TEXT },
    ],
  });
}

async function runTag(ctx) {
  const cur = cursorOf(ctx.args);
  const first = cur.take();
  const sub = (first || '').toLowerCase();
  if (!sub || sub === 'list' || sub === 'all') return showTagList(ctx, cur.peek());
  if (['add', 'create', 'new'].includes(sub)) {
    const name = cleanTagName(cur.take());
    const text = cur.rest();
    if (!name || !text) return tagForm(ctx, { name });
    return addTag(ctx, name, text);
  }
  if (['edit', 'update'].includes(sub)) {
    const name = cleanTagName(cur.take());
    const text = cur.rest();
    if (!name || !text) return tagForm(ctx, { name, editing: true });
    return addTag(ctx, name, text, { editing: true });
  }
  if (['delete', 'remove', 'del', 'rm'].includes(sub)) return deleteTag(ctx, cur.take());
  if (sub === 'info') return tagInfo(ctx, cur.take());
  if (sub === 'help') return ctx.info('Tags', 'Saved answers anyone can post.\n**/tag rules** or **!rules** posts it · **/tag list** shows them all · **/tag info rules** shows who made it.\nMods: **/tag add rules text**, **/tag edit rules text**, **/tag delete rules**. {user} and {server} fill themselves in.');
  return useTag(ctx, first);
}

function checkImage(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return { ok: true, url: null };
  if (raw.length > MAX_IMAGE) return { ok: false, reason: `That picture link is too long. Links can be up to ${MAX_IMAGE} characters.` };
  let parsed;
  try { parsed = new URL(raw); } catch { return { ok: false, reason: "That doesn't look like a link. Paste a full picture link that starts with https://." }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'Picture links have to start with **https://**.' };
  if (parsed.username || parsed.password || parsed.port) return { ok: false, reason: "That picture link has extra parts Yapin' won't show. Paste a plain picture link." };
  const host = parsed.hostname.toLowerCase();
  const allowed = IMAGE_HOSTS.has(host) || IMAGE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (!allowed) return { ok: false, reason: `Yapin' doesn't show pictures from **${host}** in cards. Upload the picture to Yapin' or **i.imgur.com** and paste that link instead.` };
  return { ok: true, url: raw };
}

export function parseColour(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return { ok: true, value: null };
  if (COLOUR_NAMES[t]) return { ok: true, value: parseInt(COLOUR_NAMES[t], 16) };
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (!m) return { ok: false, reason: 'Colours look like **#ff8800** or a name like red, blue, green, purple, pink, orange, yellow, teal or gold.' };
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return { ok: true, value: parseInt(hex, 16) };
}

const hexOf = (n) => `#${Number(n ?? COLORS.tools).toString(16).padStart(6, '0')}`;

function draftEmbed(d) {
  const e = { color: Number.isInteger(d.color) ? d.color : COLORS.tools };
  if (d.title) e.title = clip(d.title, MAX_TITLE);
  if (d.text) e.description = clip(d.text, MAX_TEXT);
  if (d.image) e.image = { url: d.image };
  if (d.footer) e.footer = { text: clip(d.footer, MAX_FOOTER) };
  if (!e.title && !e.description) e.description = '*(empty)*';
  return e;
}

const draftBox = (doc, uid) => doc.drafts[uid] || { next: 1, list: [] };
const draftsOf = (engine, sid, uid) => [...draftBox(readDoc(engine, sid), uid).list].sort((a, b) => b.updatedAt - a.updatedAt || b.n - a.n);
const findDraft = (engine, sid, uid, n) => draftsOf(engine, sid, uid).find((d) => d.n === Number(n)) || null;

function saveDraft(engine, sid, uid, n, patch) {
  return write(engine, sid, (d) => {
    const box = d.drafts[uid] ||= { next: 1, list: [] };
    let draft = n ? box.list.find((x) => x.n === Number(n)) : null;
    let dropped = null;
    if (!draft) {
      if (box.list.length >= MAX_DRAFTS) {
        box.list.sort((a, b) => a.updatedAt - b.updatedAt || a.n - b.n);
        dropped = box.list.shift();
      }
      draft = { n: box.next++, title: '', text: '', color: null, image: null, footer: '', pingRoleId: null, createdAt: Date.now(), updatedAt: Date.now() };
      box.list.push(draft);
    }
    Object.assign(draft, patch, { updatedAt: Date.now() });
    return { draft: { ...draft }, dropped: dropped ? { ...dropped } : null };
  });
}

function removeDraft(engine, sid, uid, n) {
  return write(engine, sid, (d) => {
    const box = d.drafts[uid];
    if (!box) return null;
    const i = box.list.findIndex((x) => x.n === Number(n));
    if (i < 0) return null;
    const [gone] = box.list.splice(i, 1);
    return gone;
  });
}

function restoreDraft(engine, sid, uid, draft) {
  return write(engine, sid, (d) => {
    const box = d.drafts[uid] ||= { next: draft.n + 1, list: [] };
    if (box.list.some((x) => x.n === draft.n)) return 'there';
    if (box.list.length >= MAX_DRAFTS) return 'full';
    box.list.push(draft);
    box.next = Math.max(box.next, draft.n + 1);
    return 'ok';
  });
}

async function roleNameOf(ctx, roleId) {
  if (!roleId) return null;
  const roles = await ctx.roles().catch(() => []);
  const r = roles.find((x) => x.id === roleId);
  return r ? mdSafe(r.name, 60) : null;
}

async function previewView(ctx, draft, notes = []) {
  const uid = ctx.userId;
  const ping = await roleNameOf(ctx, draft.pingRoleId);
  const head = `📝 **Preview** · draft #${draft.n}${ping ? ` · pings **@${ping}**` : ''}`;
  const lines = [head, ...notes.filter(Boolean)];
  return {
    content: clip(lines.join('\n'), 1900),
    embeds: [draftEmbed(draft)],
    components: [
      row(
        button('Edit', cid('eedit', uid, draft.n), 'primary', '✏️'),
        button('Colour', cid('ecolours', uid, draft.n), 'secondary', '🎨'),
        button('Image', cid('eimage', uid, draft.n), 'secondary', '🖼️'),
        button('Send to #channel', cid('esend', uid, draft.n), 'success', '📤'),
        button('Discard', cid('ediscard', uid, draft.n), 'danger', '🗑️'),
      ),
      row(
        button(draft.pingRoleId ? 'Change ping' : 'Ping a role', cid('eping', uid, draft.n), 'secondary', '🔔'),
        button('My drafts', cid('edrafts', uid), 'secondary', '🗂️'),
        button('New draft', cid('enew'), 'secondary', '➕'),
      ),
    ],
  };
}

async function showView(ctx, view) {
  if (onMessage(ctx)) return ctx.update(view);
  return ctx.panel(view, { ttl: PREVIEW_TTL_MS });
}

async function showPreview(ctx, draft, notes) {
  return showView(ctx, await previewView(ctx, draft, notes));
}

function draftsView(engine, sid, uid) {
  const list = draftsOf(engine, sid, uid);
  const lines = list.map((d) => `**#${d.n}** · ${mdSafe(d.title || d.text || 'untitled', 50) || 'untitled'} · edited ${shortAgo(d.updatedAt)}`);
  const body = lines.length
    ? `${lines.join('\n')}\n\n-# You keep your last ${MAX_DRAFTS}. Post one with **/embed send 2 #news**, or schedule it with **/schedule #news daily 9:00 embed 2**.`
    : 'No drafts yet. Press **New draft** or type **/embed**.';
  return {
    embeds: [card({ title: `🗂️ Your drafts (${list.length}/${MAX_DRAFTS})`, body, color: 'tools' })],
    components: [row(...list.map((d) => button(`Open #${d.n}`, cid('eopen', uid, d.n), 'secondary', '📝')), list.length < MAX_DRAFTS ? button('New draft', cid('enew'), 'primary', '➕') : null)],
  };
}

const editKey = (ctx) => `${ctx.serverId}:${ctx.userId}`;

function draftForm(ctx, draft) {
  stateOf(ctx.engine).editing.set(editKey(ctx), { n: draft?.n ?? null });
  return ctx.form({
    title: draft ? `Edit draft #${draft.n}` : 'New announcement',
    action: 'esave',
    fields: [
      { id: 'title', label: 'Title', style: 'short', required: false, value: draft?.title || '', max: MAX_TITLE, placeholder: 'Movie night this Friday!' },
      { id: 'text', label: 'Text', style: 'paragraph', required: false, value: draft?.text || '', max: MAX_TEXT, placeholder: 'Join us in voice at 8 pm.' },
      { id: 'colour', label: 'Colour (#ff8800 or a name like blue)', style: 'short', required: false, value: Number.isInteger(draft?.color) ? hexOf(draft.color) : '', max: 16 },
      { id: 'image', label: 'Picture link (optional)', style: 'short', required: false, value: draft?.image || '', max: MAX_IMAGE, placeholder: 'https://i.imgur.com/abc.png' },
      { id: 'footer', label: 'Footer (small text at the bottom)', style: 'short', required: false, value: draft?.footer || '', max: MAX_FOOTER },
    ],
  });
}

async function saveFromForm(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const v = ctx.values || {};
  const pointer = stateOf(engine).editing.get(editKey(ctx));
  const n = pointer?.n ?? null;
  const existing = n ? findDraft(engine, sid, uid, n) : null;
  if (n && !existing) return ctx.warn('That draft is gone', 'It may have been discarded. Start a new one with **/embed**.');
  const title = String(v.title ?? '').trim().slice(0, MAX_TITLE);
  const text = String(v.text ?? '').trim().slice(0, MAX_TEXT);
  if (!title && !text) return ctx.warn('Nothing to show yet', 'Give the announcement a title or some text.');
  const notes = [];
  const patch = { title, text, footer: String(v.footer ?? '').trim().slice(0, MAX_FOOTER) };
  const colour = parseColour(v.colour);
  if (colour.ok) patch.color = colour.value;
  else notes.push(`⚠️ ${colour.reason} I kept the old colour.`);
  const rawImage = String(v.image ?? '').trim();
  if (/^(none|off|remove|clear)$/i.test(rawImage)) patch.image = null;
  else {
    const img = checkImage(rawImage);
    if (img.ok) patch.image = img.url;
    else notes.push(`⚠️ ${img.reason}`);
  }
  const { draft, dropped } = saveDraft(engine, sid, uid, n, patch);
  stateOf(engine).editing.set(editKey(ctx), { n: draft.n });
  if (dropped) notes.push(`-# You keep ${MAX_DRAFTS} drafts, so your oldest one (#${dropped.n}) was removed.`);
  return showPreview(ctx, draft, notes);
}

async function saveImageForm(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const n = stateOf(engine).editing.get(editKey(ctx))?.n;
  const draft = n ? findDraft(engine, sid, uid, n) : null;
  if (!draft) return ctx.warn('That draft panel expired', 'Open your draft again with **/embed list**.');
  const raw = String(ctx.values?.image ?? '').trim();
  if (!raw || /^(none|off|remove|clear)$/i.test(raw)) {
    const res = saveDraft(engine, sid, uid, n, { image: null });
    return showPreview(ctx, res.draft, ['🖼️ Picture removed.']);
  }
  const img = checkImage(raw);
  if (!img.ok) return showPreview(ctx, draft, [`⚠️ ${img.reason}`]);
  const res = saveDraft(engine, sid, uid, n, { image: img.url });
  return showPreview(ctx, res.draft);
}

async function saveColourForm(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const n = stateOf(engine).editing.get(editKey(ctx))?.n;
  const draft = n ? findDraft(engine, sid, uid, n) : null;
  if (!draft) return ctx.warn('That draft panel expired', 'Open your draft again with **/embed list**.');
  const colour = parseColour(ctx.values?.colour);
  if (!colour.ok) return showPreview(ctx, draft, [`⚠️ ${colour.reason}`]);
  const res = saveDraft(engine, sid, uid, n, { color: colour.value });
  return showPreview(ctx, res.draft);
}

async function draftOr(ctx, n, fn) {
  const draft = findDraft(ctx.engine, ctx.serverId, ctx.userId, n);
  if (!draft) return ctx.warn('That draft is gone', 'It may have been discarded or replaced by a newer one. See yours with **/embed list**.');
  return fn(draft);
}

function colourView(draft, uid) {
  const swatches = SWATCHES.map((s) => button(s.name, cid('ecolour', uid, draft.n, s.hex), Number(draft.color) === parseInt(s.hex, 16) ? 'primary' : 'secondary', s.emoji));
  return {
    content: `🎨 Pick a colour for draft #${draft.n}. Now: **${hexOf(draft.color)}**`,
    embeds: [draftEmbed(draft)],
    components: [...rows(swatches), row(button('Custom…', cid('ecustom', uid, draft.n), 'secondary', '🖌️'), button('Back', cid('eopen', uid, draft.n), 'secondary', '⬅️'))],
  };
}

async function textChannels(ctx) {
  return (await ctx.channels('text').catch(() => [])).filter((c) => c.type === 'text' || c.kind === 'text');
}

async function channelPicker(ctx, draft) {
  const uid = ctx.userId;
  const chans = (await textChannels(ctx)).slice(0, 25);
  const embeds = [draftEmbed(draft)];
  const content = `📤 Where should draft #${draft.n} go?\n-# Or type **/embed send ${draft.n} #channel**.`;
  const back = row(button('Back', cid('eopen', uid, draft.n), 'secondary', '⬅️'));
  if (!chans.length) return ctx.update({ content: `${content}\nI can't see any text channels.`, embeds, components: [back] });
  const asSelect = () => ctx.update({ content, embeds, components: [select(cid('epick', uid, draft.n), chans.map((c) => ({ label: `#${clip(c.name, 90)}`, value: c.id })), { placeholder: 'Pick a channel' }), back] });
  const asButtons = () => ctx.update({ content, embeds, components: [...rows(chans.slice(0, 15).map((c) => button(`#${clip(c.name, 70)}`, cid('eto', uid, draft.n, c.id), 'secondary'))).slice(0, 3), back] });
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', asSelect, asButtons);
}

async function pingableRoles(ctx) {
  const roles = await ctx.roles().catch(() => []);
  return roles.filter((r) => canPing(r, ctx.serverId));
}

async function rolePicker(ctx, draft) {
  const uid = ctx.userId;
  const roles = (await pingableRoles(ctx)).slice(0, 25);
  const back = button('Back', cid('eopen', uid, draft.n), 'secondary', '⬅️');
  const none = button('No ping', cid('erole', uid, draft.n, '-'), draft.pingRoleId ? 'secondary' : 'primary', '🔕');
  const embeds = [draftEmbed(draft)];
  if (!roles.length) {
    return ctx.update({
      content: "🔔 No role here can be pinged. In Server settings → Roles, turn on **Let anyone @mention** for the role you want, then try again.",
      embeds, components: [row(none, back)],
    });
  }
  const content = `🔔 Which role should draft #${draft.n} ping? Only roles anyone may @mention are listed.`;
  const asSelect = () => ctx.update({ content, embeds, components: [select(cid('erolepick', uid, draft.n), roles.map((r) => ({ label: `@${clip(r.name, 90)}`, value: r.id })), { placeholder: 'Pick a role' }), row(none, back)] });
  const asButtons = () => ctx.update({ content, embeds, components: [...rows(roles.slice(0, 15).map((r) => button(`@${clip(r.name, 70)}`, cid('erole', uid, draft.n, r.id), 'secondary'))).slice(0, 3), row(none, back)] });
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', asSelect, asButtons);
}

async function setPing(ctx, draft, roleId) {
  if (!roleId || roleId === '-') {
    const res = saveDraft(ctx.engine, ctx.serverId, ctx.userId, draft.n, { pingRoleId: null });
    return showPreview(ctx, res.draft, ['🔕 No ping.']);
  }
  const role = (await pingableRoles(ctx)).find((r) => r.id === roleId);
  if (!role) return showPreview(ctx, draft, ["⚠️ That role can't be pinged any more. Pick another one."]);
  const res = saveDraft(ctx.engine, ctx.serverId, ctx.userId, draft.n, { pingRoleId: role.id });
  return showPreview(ctx, res.draft);
}

async function pingContent(ctx, draft) {
  if (!draft.pingRoleId) return { content: '', note: null };
  const role = (await pingableRoles(ctx)).find((r) => r.id === draft.pingRoleId);
  if (!role) return { content: '', note: "The ping role can't be pinged any more, so I left the ping out." };
  return { content: `<@&${role.id}>`, note: null };
}

async function postDraft(ctx, draft, channelId) {
  const channel = (await textChannels(ctx)).find((c) => c.id === channelId);
  if (!channel) return ctx.warn("I can't find that channel", 'It may have been deleted. Pick another one.');
  if (onCooldown(ctx.engine, ctx.serverId, ctx.userId, `send:${draft.n}:${channel.id}`, SEND_GUARD_MS)) {
    return ctx.info('Already posted', `Draft #${draft.n} just went out in <#${channel.id}>. Give it a few seconds if you really want it there twice.`);
  }
  const { content, note } = await pingContent(ctx, draft);
  let sent;
  try {
    sent = await ctx.send(channel.id, { content, embeds: [draftEmbed(draft)] }, { priority: 'high' });
  } catch (e) {
    stateOf(ctx.engine).cooldowns.delete(`${ctx.serverId}:${ctx.userId}:send:${draft.n}:${channel.id}`);
    return ctx.fail(e, { action: `post in #${channel.name}`, perm: 'send_messages' });
  }
  const { engine, serverId: sid } = ctx;
  const undo = adminUndo(ctx, 'post', async () => {
    if (sent?.id) await engine.bot.delete(channel.id, sent.id).catch((e) => { if (e?.status !== 404) throw e; });
  });
  const lines = [`📤 Posted draft #${draft.n} in <#${channel.id}>.`, note ? `⚠️ ${note}` : null, `-# Your draft stays saved. Schedule it with **/schedule #${clip(channel.name, 40)} daily 9:00 embed ${draft.n}**.`].filter(Boolean);
  const view = {
    content: lines.join('\n'),
    embeds: [draftEmbed(draft)],
    components: [row(undo.button, button('Back to draft', cid('eopen', ctx.userId, draft.n), 'secondary', '📝'))],
  };
  return onMessage(ctx) ? ctx.update(view) : ctx.panel(view, { ttl: PREVIEW_TTL_MS });
}

async function discardDraft(ctx, n) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const gone = removeDraft(engine, sid, uid, n);
  if (!gone) return ctx.warn('That draft is gone', 'It was already discarded. See yours with **/embed list**.');
  const undo = adminUndo(ctx, `discard of draft #${gone.n}`, async (i) => {
    const res = restoreDraft(engine, sid, uid, gone);
    if (res === 'ok' || res === 'there') return true;
    await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring it back", `You already have ${MAX_DRAFTS} drafts. Discard one first.`)] });
    return false;
  });
  const view = { content: '', embeds: [dialog.ok('Draft discarded', `Draft #${gone.n} is gone.`)], components: [row(undo.button)] };
  return onMessage(ctx) ? ctx.update(view) : ctx.ephemeral(view);
}

async function runEmbed(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid, userId: uid } = ctx;
  const tokens = tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const num = (t) => (/^#?\d{1,6}$/.test(String(t ?? '')) ? Number(String(t).replace('#', '')) : null);
  if (!sub || sub === 'new') return draftForm(ctx, null);
  if (sub === 'list' || sub === 'drafts') return ctx.ephemeral(draftsView(engine, sid, uid));
  if (sub === 'open' || sub === 'show' || sub === 'preview' || sub === 'edit') {
    const n = num(tokens[1]) ?? draftsOf(engine, sid, uid)[0]?.n;
    if (!n) return ctx.warn('No drafts yet', 'Start one with **/embed**.');
    return draftOr(ctx, n, (d) => (sub === 'edit' ? draftForm(ctx, d) : showPreview(ctx, d)));
  }
  if (sub === 'send' || sub === 'post') {
    let rest = tokens.slice(1);
    let n = null;
    if (rest.length > 1 && /^\d{1,6}$/.test(rest[0])) { n = Number(rest[0]); rest = rest.slice(1); }
    n ??= draftsOf(engine, sid, uid)[0]?.n ?? null;
    if (!n) return ctx.warn('No drafts yet', 'Make one with **/embed** first.');
    const draft = findDraft(engine, sid, uid, n);
    if (!draft) return ctx.warn("You don't have that draft", `There's no draft #${n}. See yours with **/embed list**.`);
    if (!rest.length) return ctx.warn('Which channel?', `Try \`/embed send ${n} #announcements\`.`);
    const ch = await ctx.findChannel(rest.join(' '));
    if (!ch) return ctx.warn("I couldn't find that channel", `No text channel matches **${mdSafe(rest.join(' '), 40)}**.`);
    return postDraft(ctx, draft, ch.id);
  }
  if (sub === 'delete' || sub === 'discard' || sub === 'remove') {
    const n = num(tokens[1]);
    if (!n) return ctx.warn('Which draft?', 'Try `/embed delete 2`. See yours with **/embed list**.');
    return discardDraft(ctx, n);
  }
  const guess = didYouMean(sub, ['new', 'list', 'open', 'edit', 'send', 'delete']);
  return ctx.warn("I didn't get that", `I don't know **${mdSafe(sub, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry **/embed** for a new announcement, **/embed list** for your drafts or **/embed send 2 #news**.`);
}

function parseClock(raw) {
  const t = String(raw ?? '').trim().toLowerCase().replace(/[,.]$/, '');
  if (t === 'noon' || t === 'midday') return '12:00';
  if (t === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?(am|pm)?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function takeClock(cur) {
  const start = cur.mark();
  if (/^at$/i.test(cur.peek() || '')) cur.skip();
  const t = cur.peek();
  const next = cur.peek(1);
  if (t && next && /^(am|pm)$/i.test(next) && /^\d{1,2}(:\d{2})?$/.test(t)) {
    const c = parseClock(t + next);
    if (c) { cur.skip(2); return c; }
  }
  const c = parseClock(t);
  if (c) { cur.skip(); return c; }
  cur.reset(start);
  return null;
}

function dayList(raw) {
  const t = String(raw ?? '').toLowerCase().replace(/[.,]$/, '');
  if (!t) return null;
  if (/^weekdays?$/.test(t)) return [1, 2, 3, 4, 5];
  if (/^weekends?$/.test(t)) return [0, 6];
  const out = [];
  for (const part of t.split(/[,/+&]/).filter(Boolean)) {
    const p = part.replace(/s$/, '');
    const i = DAY_NAMES.findIndex((d) => {
      const n = d.toLowerCase();
      return n === p || (p.length >= 2 && n.startsWith(p)) || (p === 'thur' || p === 'thurs' ? n === 'thursday' : false) || (p === 'tue' || p === 'tues' ? n === 'tuesday' : false);
    });
    if (i < 0) return null;
    out.push(i);
  }
  return out.length ? out : null;
}

function takeDays(cur) {
  const days = new Set();
  for (;;) {
    const t = cur.peek();
    if (t && /^(and|on)$/i.test(t) && days.size && dayList(cur.peek(1))) { cur.skip(); continue; }
    const d = dayList(t);
    if (!d) break;
    d.forEach((x) => days.add(x));
    cur.skip();
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

function takeDurationFrom(cur) {
  for (let n = 4; n >= 1; n--) {
    const parts = [];
    for (let k = 0; k < n; k++) { const t = cur.peek(k); if (t === null) break; parts.push(t); }
    if (parts.length < n) continue;
    const ms = parseDuration(parts.join(' '), { bareUnit: 'm' });
    if (ms !== null && !/^\d+$/.test(parts.join(''))) { cur.skip(n); return ms; }
  }
  return null;
}

const needTime = (what) => ({ error: `When during the day? Add a time, like \`${what} 9:00\` or \`${what} 6pm\`.` });

function parseTiming(cur) {
  const word = (cur.peek() || '').toLowerCase();
  if (word === 'in') {
    cur.skip();
    const ms = takeDurationFrom(cur);
    if (!ms) return { error: 'How long from now? Try `in 2h`, `in 30m` or `in 1d 6h`.' };
    return { kind: 'in', ms };
  }
  if (word === 'daily' || word === 'everyday') {
    cur.skip();
    const time = takeClock(cur);
    return time ? { kind: 'daily', time } : needTime(word);
  }
  if (word === 'weekly') {
    cur.skip();
    if (/^on$/i.test(cur.peek() || '')) cur.skip();
    const days = takeDays(cur);
    if (!days) return { error: 'Which day? Try `weekly mon 9:00` or `weekly mon,thu 18:30`.' };
    const time = takeClock(cur);
    return time ? { kind: 'weekly', days, time } : needTime(`weekly ${cur.peek(-1) || 'mon'}`);
  }
  if (word === 'monthly') {
    cur.skip();
    return monthlyRest(cur);
  }
  if (word === 'every') {
    cur.skip();
    const next = (cur.peek() || '').toLowerCase();
    if (next === 'day' || next === 'night' || next === 'morning') {
      cur.skip();
      const time = takeClock(cur);
      return time ? { kind: 'daily', time } : needTime('every day');
    }
    if (next === 'month') {
      cur.skip();
      return monthlyRest(cur);
    }
    if (next === 'week') {
      cur.skip();
      if (/^on$/i.test(cur.peek() || '')) cur.skip();
    }
    const days = takeDays(cur);
    if (days) {
      const time = takeClock(cur);
      return time ? { kind: 'weekly', days, time } : needTime('every monday');
    }
    if (next === 'hour') { cur.skip(); return { kind: 'every', ms: 3600_000 }; }
    const ms = takeDurationFrom(cur);
    if (ms) return { kind: 'every', ms };
    return { error: 'How often? Try `every monday 9:00`, `every day 18:00`, `every weekday 8am` or `every 6h`.' };
  }
  if (word === 'on' || /^\d{4}-\d{1,2}-\d{1,2}$/.test(word)) {
    if (word === 'on') cur.skip();
    const d = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(cur.peek() || '');
    if (!d) {
      const days = takeDays(cur);
      if (days && days.length === 1) {
        const time = takeClock(cur);
        return time ? { kind: 'nextday', day: days[0], time } : needTime('on friday');
      }
      return { error: 'Which date? Write it like `on 2026-12-25 10:00`.' };
    }
    cur.skip();
    const time = takeClock(cur);
    if (!time) return needTime(`on ${d[0]}`);
    return { kind: 'on', y: Number(d[1]), mo: Number(d[2]), d: Number(d[3]), time };
  }
  if (word === 'tomorrow' || word === 'today' || word === 'tonight') {
    cur.skip();
    const time = takeClock(cur);
    return time ? { kind: 'at', time, plusDays: word === 'tomorrow' ? 1 : 0, strictToday: word !== 'tomorrow' } : needTime(word);
  }
  if (word === 'at') {
    const time = takeClock(cur);
    return time ? { kind: 'at', time, plusDays: 0 } : { error: 'What time? Try `at 18:00`.' };
  }
  return { error: 'When should it go out? Try `in 2h`, `daily 18:00`, `every monday 9:00` or `on 2026-12-25 10:00`.' };
}

function monthlyRest(cur) {
  if (/^on$/i.test(cur.peek() || '')) cur.skip();
  if (/^the$/i.test(cur.peek() || '')) cur.skip();
  const m = /^(\d{1,2})(st|nd|rd|th)?$/i.exec(cur.peek() || '');
  if (!m) return { error: 'Which day of the month? Try `monthly 15 12:00` (days 1 to 28).' };
  const day = Number(m[1]);
  if (day < 1 || day > 28) return { error: 'Monthly posts can use days 1 to 28, so they happen every month.' };
  cur.skip();
  const time = takeClock(cur);
  return time ? { kind: 'monthly', day, time } : needTime(`monthly ${day}`);
}

function resolveTiming(t, tz, now) {
  const [hh, mm] = (t.time || '00:00').split(':').map(Number);
  if (t.kind === 'in') {
    if (t.ms < MIN_AHEAD_MS) return { error: 'Pick a time at least a minute from now.' };
    if (t.ms > MAX_AHEAD_MS) return { error: 'I can schedule posts up to 2 years ahead.' };
    return { at: now + t.ms, repeat: null };
  }
  if (t.kind === 'every') {
    if (t.ms < MIN_REPEAT_MS) return { error: 'Repeating posts need to be at least 1 hour apart, so the channel (and my message budget) stays calm.' };
    if (t.ms > 366 * 86_400_000) return { error: 'Repeats can be at most a year apart.' };
    return { at: null, repeat: { everyMs: t.ms } };
  }
  if (t.kind === 'daily') return { at: null, repeat: { daily: t.time, tz } };
  if (t.kind === 'weekly') return { at: null, repeat: { weekly: { days: t.days, time: t.time }, tz } };
  if (t.kind === 'monthly') return { at: null, repeat: { monthly: { day: t.day, time: t.time }, tz } };
  if (t.kind === 'on') {
    const check = new Date(Date.UTC(t.y, t.mo - 1, t.d));
    if (check.getUTCFullYear() !== t.y || check.getUTCMonth() !== t.mo - 1 || check.getUTCDate() !== t.d) return { error: "That date doesn't exist. Write it like `2026-12-25`." };
    const at = zonedTime(t.y, t.mo, t.d, hh, mm, tz);
    if (at <= now) return { error: 'That time has already passed. Pick one in the future.' };
    if (at - now > MAX_AHEAD_MS) return { error: 'I can schedule posts up to 2 years ahead.' };
    return { at, repeat: null };
  }
  const p = partsAt(now, tz);
  if (t.kind === 'nextday') {
    for (let i = 0; i <= 7; i++) {
      const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
      if (day.getUTCDay() !== t.day) continue;
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
      if (at > now) return { at, repeat: null };
    }
    return { error: 'That time has already passed. Pick one in the future.' };
  }
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + (t.plusDays || 0)));
  let at = zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm, tz);
  if (at <= now) {
    if (t.strictToday) return { error: 'That time today has already passed. Try `tomorrow` instead.' };
    const nextDay = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    at = zonedTime(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hh, mm, tz);
  }
  return { at, repeat: null };
}

function daysText(days) {
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '1,2,3,4,5') return 'weekday';
  if (set === '0,6') return 'Saturday and Sunday';
  if (set === '0,1,2,3,4,5,6') return 'day';
  const names = days.map((d) => DAY_NAMES[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

export function repeatText(rep) {
  if (!rep) return 'once';
  const zone = rep.tz ? ` (${tzLabel(rep.tz)})` : '';
  if (rep.everyMs) return `every ${formatDuration(rep.everyMs)}`;
  if (rep.daily) return `every day at ${rep.daily}${zone}`;
  if (rep.weekly) return `every ${daysText(rep.weekly.days)} at ${rep.weekly.time}${zone}`;
  if (rep.monthly) {
    const n = rep.monthly.day;
    const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
    return `on the ${n}${suffix} of every month at ${rep.monthly.time}${zone}`;
  }
  return 'on repeat';
}

export function parseSchedule(text, { tz: defaultTz = 'UTC', now }) {
  const cur = cursorOf(text);
  const timing = parseTiming(cur);
  if (timing.error) return timing;
  let tz = defaultTz;
  const tzWord = (cur.peek() || '').toLowerCase();
  if (tzWord === 'tz' || tzWord === 'timezone' || tzWord === 'time-zone') {
    cur.skip();
    const raw = cur.take();
    const zone = canonicalZone(raw);
    if (!zone) return { error: `I don't know the time zone **${mdSafe(raw || '?', 40)}**. Use a name like Europe/London or America/New_York.` };
    tz = zone;
  } else if (/\//.test(cur.peek() || '') && canonicalZone(cur.peek())) {
    tz = canonicalZone(cur.take());
  }
  const when = resolveTiming(timing, tz, now);
  if (when.error) return when;
  let draftNo = null;
  if (/^(embed|draft)$/i.test(cur.peek() || '') && /^#?\d{1,6}$/.test(cur.peek(1) || '')) {
    cur.skip();
    draftNo = Number(cur.take().replace('#', ''));
  }
  return { ...when, tz, draftNo, text: cur.rest() };
}

const postKey = (id) => `post-${id}`;
const postsOf = (engine, sid) => Object.values(readDoc(engine, sid).posts).sort((a, b) => a.id - b.id);
const jobOf = (engine, sid, id) => engine.scheduler.list({ kind: POST_KIND, serverId: sid, key: postKey(id) })[0] || null;

function schedulePost(engine, sid, p) {
  const now = engine.scheduler.now();
  const at = p.repeat ? null : Math.max(p.at, now + 5000);
  return engine.scheduler.schedule({ kind: POST_KIND, serverId: sid, key: postKey(p.id), data: { postId: p.id }, ...(at ? { at } : {}), repeat: p.repeat || null });
}

function postPreview(p) {
  if (p.embed) return `📝 ${mdSafe(p.embed.title || p.embed.text || 'announcement', 50)}${p.text ? ` + "${mdSafe(p.text, 30)}"` : ''}`;
  return `"${mdSafe(p.text, 60)}"`;
}

function postLine(engine, sid, p, now) {
  const job = p.paused ? null : jobOf(engine, sid, p.id);
  const how = p.repeat ? repeatText(p.repeat) : `once`;
  let state;
  if (p.paused) state = `⏸️ paused${p.pauseReason ? ` (${p.pauseReason})` : ''}`;
  else if (job) state = `next ${whenText(job.at, p.repeat?.tz || p.tz, now)} (${untilText(job.at - now)})`;
  else state = '⚠️ not scheduled';
  return `**#${p.id}** · <#${p.channelId}> · ${how}\n${state} · ${postPreview(p)}`;
}

function postsView(engine, sid, notice, extra = null) {
  const now = engine.scheduler.now();
  const list = postsOf(engine, sid);
  const lines = list.map((p) => postLine(engine, sid, p, now));
  const help = '-# New: `/schedule #news every monday 9:00 Meeting tonight!` · `/schedule #news in 2h text` · `/schedule #news on 2026-12-25 10:00 text` · add `tz Europe/London` or `embed 2`';
  const body = [notice, lines.length ? lines.join('\n\n') : 'Nothing scheduled yet.', '', help].filter((x) => x !== null && x !== undefined).join('\n');
  const btns = list.slice(0, POSTS_WITH_BUTTONS).flatMap((p) => [
    p.paused ? button(`Resume #${p.id}`, cid('sresume', p.id), 'success', '▶️') : button(`Pause #${p.id}`, cid('spause', p.id), 'secondary', '⏸️'),
    button(`Cancel #${p.id}`, cid('scancel', p.id), 'danger', '🗑️'),
  ]);
  const comps = rows(btns).slice(0, 4);
  comps.push(row(button('New scheduled post', cid('snew'), 'primary', '➕'), button('Refresh', cid('slist'), 'secondary', '🔄'), extra));
  return {
    content: '',
    embeds: [card({ title: `⏰ Scheduled posts (${list.length}/${MAX_POSTS})`, body: clip(body, 4000), color: 'tools', footer: list.length > POSTS_WITH_BUTTONS ? `Buttons for the first ${POSTS_WITH_BUTTONS}; type /schedule pause 12 for the rest` : undefined })],
    components: comps,
  };
}

async function showPosts(ctx, notice) {
  const view = postsView(ctx.engine, ctx.serverId, notice);
  return onMessage(ctx) ? ctx.update(view) : ctx.ephemeral(view);
}

function nextPostId(d) {
  const used = Object.keys(d.posts).map(Number);
  const next = Math.max(Number(d.nextPost) || 1, used.length ? Math.max(...used) + 1 : 1);
  d.nextPost = next + 1;
  return next;
}

async function createPost(ctx, text) {
  const { engine, serverId: sid } = ctx;
  const cur = cursorOf(text);
  const chanTok = cur.take();
  if (!chanTok) return showPosts(ctx);
  const channel = await ctx.findChannel(chanTok);
  if (!channel) return ctx.warn("I couldn't find that channel", `No text channel matches **${mdSafe(chanTok, 40)}**. Start with the channel, like \`/schedule #news daily 18:00 Good evening!\`.`);
  const now = engine.scheduler.now();
  const parsed = parseSchedule(cur.rest(), { tz: serverZone(engine, sid), now });
  if (parsed.error) return ctx.warn("I didn't get the time", parsed.error);
  let embed = null;
  if (parsed.draftNo) {
    const draft = findDraft(engine, sid, ctx.userId, parsed.draftNo);
    if (!draft) return ctx.warn("You don't have that draft", `There's no draft #${parsed.draftNo}. See yours with **/embed list**.`);
    embed = { n: draft.n, title: draft.title, text: draft.text, color: draft.color, image: draft.image, footer: draft.footer, pingRoleId: draft.pingRoleId };
  }
  const body = parsed.text;
  if (!body && !embed) return ctx.warn('What should I post?', 'Add the message after the time, like `/schedule #news daily 18:00 Good evening!`, or post a saved announcement with `embed 2`.');
  if (body.length > MAX_POST_TEXT) return ctx.warn('That message is too long', `Scheduled posts can be up to ${MAX_POST_TEXT} characters. This one is ${body.length}.`);
  const created = write(engine, sid, (d) => {
    if (Object.keys(d.posts).length >= MAX_POSTS) return { error: 'full' };
    const id = nextPostId(d);
    const p = { id, channelId: channel.id, text: body, embed, repeat: parsed.repeat, at: parsed.at, tz: parsed.tz, createdBy: ctx.userId, createdAt: now, paused: false, pauseReason: null, lastRunAt: null, runs: 0 };
    d.posts[id] = p;
    return { post: p };
  });
  if (created.error) return ctx.warn('Too many scheduled posts', `This server has ${MAX_POSTS}, the most I keep. Cancel one with \`/schedule cancel 3\` first.`);
  const p = created.post;
  let job;
  try {
    job = schedulePost(engine, sid, p);
  } catch (e) {
    write(engine, sid, (d) => { delete d.posts[p.id]; });
    return ctx.fail(e);
  }
  const undo = adminUndo(ctx, `post #${p.id}`, async () => {
    engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: sid, key: postKey(p.id) });
    write(engine, sid, (d) => { delete d.posts[p.id]; });
  }, `/schedule cancel ${p.id}`);
  const lines = [
    `**#${p.id}** posts ${p.repeat ? repeatText(p.repeat) : 'once'} in <#${channel.id}>.`,
    `Next: **${whenText(job.at, p.tz, now)}** (${untilText(job.at - now)}).`,
    `${postPreview(p)}`,
    /@(everyone|here)/i.test(body) ? "-# @everyone and @here won't ping. To ping people, use a role anyone may @mention." : null,
    `-# Pause with **/schedule pause ${p.id}**, cancel with **/schedule cancel ${p.id}**, see all with **/schedule list**.`,
  ];
  return ctx.ok('Post scheduled', lines.filter(Boolean).join('\n'), { components: [row(undo.button)] });
}

const idFrom = (t) => (/^#?\d{1,6}$/.test(String(t ?? '')) ? Number(String(t).replace('#', '')) : null);

function missingPost(ctx, id) {
  return ctx.warn('No such scheduled post', `There's no post **#${id ?? '?'}**. See them all with **/schedule list**.`);
}

async function pausePost(ctx, id, { fromList = false } = {}) {
  const { engine, serverId: sid } = ctx;
  const p = readDoc(engine, sid).posts[id];
  if (!p) return missingPost(ctx, id);
  if (p.paused) return fromList ? showPosts(ctx, `#${id} is already paused.`) : ctx.info('Already paused', `Post **#${id}** is already paused. Resume it with **/schedule resume ${id}**.`);
  engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: sid, key: postKey(id) });
  write(engine, sid, (d) => { if (d.posts[id]) Object.assign(d.posts[id], { paused: true, pauseReason: null }); });
  if (fromList) return showPosts(ctx, `⏸️ Paused #${id}.`);
  return ctx.ok('Post paused', `Post **#${id}** won't go out until you run **/schedule resume ${id}**.`);
}

async function resumePost(ctx, id, { fromList = false } = {}) {
  const { engine, serverId: sid } = ctx;
  const p = readDoc(engine, sid).posts[id];
  if (!p) return missingPost(ctx, id);
  if (!p.paused) return fromList ? showPosts(ctx, `#${id} is already running.`) : ctx.info('Already running', `Post **#${id}** isn't paused.`);
  const channel = await engine.bot.channel(p.channelId);
  if (!channel) return ctx.warn('That channel is gone', `Post **#${id}** was for a channel that no longer exists. Cancel it with **/schedule cancel ${id}** and schedule it again.`);
  const now = engine.scheduler.now();
  let job;
  try {
    job = schedulePost(engine, sid, { ...p, paused: false });
  } catch (e) {
    return ctx.fail(e);
  }
  write(engine, sid, (d) => { if (d.posts[id]) Object.assign(d.posts[id], { paused: false, pauseReason: null }); });
  const late = !p.repeat && p.at <= now ? ' Its time passed while it was paused, so it goes out right away.' : '';
  const text = `Post **#${id}** is back on. Next: **${whenText(job.at, p.repeat?.tz || p.tz, now)}**.${late}`;
  if (fromList) return showPosts(ctx, `▶️ Resumed #${id}.${late}`);
  return ctx.ok('Post resumed', text);
}

async function cancelPost(ctx, id, { fromList = false } = {}) {
  const { engine, serverId: sid } = ctx;
  const p = readDoc(engine, sid).posts[id];
  if (!p) return missingPost(ctx, id);
  engine.scheduler.cancelWhere({ kind: POST_KIND, serverId: sid, key: postKey(id) });
  write(engine, sid, (d) => { delete d.posts[id]; });
  const undo = adminUndo(ctx, `cancel of #${id}`, async (i) => {
    const res = write(engine, sid, (d) => {
      if (d.posts[id]) return 'there';
      if (Object.keys(d.posts).length >= MAX_POSTS) return 'full';
      d.posts[id] = p;
      return 'ok';
    });
    if (res === 'full') {
      await i.ephemeral('', { embeds: [dialog.warn("Couldn't bring it back", `This server already has ${MAX_POSTS} scheduled posts.`)] });
      return false;
    }
    if (res === 'ok' && !p.paused) {
      try { schedulePost(engine, sid, p); } catch (e) { write(engine, sid, (d) => { delete d.posts[id]; }); throw e; }
    }
    return true;
  });
  const text = `Post **#${id}** (${p.repeat ? repeatText(p.repeat) : 'once'} in <#${p.channelId}>) won't go out.`;
  if (fromList) {
    return ctx.update(postsView(engine, sid, `🗑️ Cancelled #${id}.`, undo.button));
  }
  return ctx.ok('Post cancelled', text, { components: [row(undo.button)] });
}

function scheduleForm(ctx) {
  const tz = serverZone(ctx.engine, ctx.serverId);
  return ctx.form({
    title: 'New scheduled post',
    action: 'ssave',
    fields: [
      { id: 'channel', label: 'Channel', style: 'short', placeholder: '#announcements', max: 100 },
      { id: 'when', label: 'When', style: 'short', placeholder: 'every monday 9:00 · in 2h · on 2026-12-25 10:00', max: 100 },
      { id: 'text', label: 'Message (or embed 2 for a saved draft)', style: 'paragraph', max: MAX_POST_TEXT },
      { id: 'tz', label: `Time zone (empty = ${tz})`, style: 'short', required: false, placeholder: 'Europe/London', max: 64 },
    ],
  });
}

async function saveScheduleForm(ctx) {
  const v = ctx.values || {};
  const channel = String(v.channel ?? '').trim();
  const when = String(v.when ?? '').trim();
  const tz = String(v.tz ?? '').trim();
  const text = String(v.text ?? '').trim();
  if (!channel || !when) return ctx.warn('Something is missing', 'Fill in the channel and when it should go out.');
  const target = await ctx.findChannel(channel);
  if (!target) return ctx.warn("I couldn't find that channel", `No text channel matches **${mdSafe(channel, 40)}**.`);
  return createPost(ctx, `<#${target.id}> ${when}${tz ? ` tz ${tz.split(/\s+/)[0]}` : ''} ${text}`);
}

const SCHEDULE_SUBS = ['list', 'cancel', 'pause', 'resume', 'new', 'help'];

async function runSchedule(ctx) {
  await ctx.require('admin');
  const cur = cursorOf(ctx.args);
  const sub = (cur.peek() || '').toLowerCase();
  if (!sub || sub === 'list' || sub === 'all') return showPosts(ctx);
  if (sub === 'new' || sub === 'add') return scheduleForm(ctx);
  if (['cancel', 'delete', 'remove', 'stop', 'pause', 'resume', 'unpause'].includes(sub)) {
    cur.skip();
    const id = idFrom(cur.peek());
    if (!id) return ctx.warn('Which post?', `Try \`/schedule ${sub} 3\`. See the numbers with **/schedule list**.`);
    if (sub === 'pause') return pausePost(ctx, id);
    if (sub === 'resume' || sub === 'unpause') return resumePost(ctx, id);
    return cancelPost(ctx, id);
  }
  if (sub === 'help') {
    return ctx.info('Scheduled posts', [
      '`/schedule #news in 2h Doors open soon!`',
      '`/schedule #news daily 18:00 Good evening!`',
      '`/schedule #news every monday 9:00 Weekly meeting in voice!`',
      '`/schedule #news every weekday 8am tz Europe/London Morning!`',
      '`/schedule #news monthly 1 12:00 New month, new goals`',
      '`/schedule #news on 2026-12-25 10:00 Merry Christmas!`',
      '`/schedule #news weekly mon 9:00 embed 2` posts your saved announcement #2',
      `Times use the server's time zone (${serverZone(ctx.engine, ctx.serverId)}) unless you add \`tz Area/City\`.`,
      '`/schedule list` · `/schedule pause 3` · `/schedule resume 3` · `/schedule cancel 3`',
    ].join('\n'));
  }
  return createPost(ctx, ctx.args);
}

async function runPostJob(job, engine) {
  const sid = job.serverId;
  const id = job.data?.postId;
  if (!sid || !id) return;
  const p = readDoc(engine, sid).posts[id];
  if (!p) {
    if (job.repeat) engine.scheduler.cancel(job.id);
    return;
  }
  if (p.paused) return;
  if (!engine.settings.isEnabled(sid, ID)) {
    if (!job.repeat) write(engine, sid, (d) => { if (d.posts[id]) Object.assign(d.posts[id], { paused: true, pauseReason: 'Tools was uninstalled when it was due' }); });
    return;
  }
  if (job.repeat && job.lateByMs > LATE_SKIP_MS) {
    write(engine, sid, (d) => { if (d.posts[id]) d.posts[id].lastSkippedAt = job.at; });
    return;
  }
  if (p.lastRunAt === job.at) {
    if (!job.repeat) write(engine, sid, (d) => { delete d.posts[id]; });
    return;
  }
  const before = p.lastRunAt;
  write(engine, sid, (d) => { if (d.posts[id]) d.posts[id].lastRunAt = job.at; });
  const payload = await postPayload(engine, sid, p);
  try {
    await engine.budget.send({ serverId: sid, channelId: p.channelId, content: payload.content, opts: { embeds: payload.embeds }, priority: 'normal', key: `tools:post:${sid}:${id}` });
  } catch (e) {
    write(engine, sid, (d) => { if (d.posts[id]) d.posts[id].lastRunAt = before; });
    if (e?.status === 404) {
      engine.scheduler.cancel(job.id);
      write(engine, sid, (d) => { if (d.posts[id]) Object.assign(d.posts[id], { paused: true, pauseReason: 'its channel is gone' }); });
      await logProblem(engine, sid, 'Scheduled post paused', `Post **#${id}** (${p.repeat ? repeatText(p.repeat) : 'once'}) was meant for a channel that no longer exists, so I paused it.\nCancel it with **/schedule cancel ${id}** and schedule it again for another channel.`);
      return;
    }
    if (e?.status === 403 && !p.warned) {
      write(engine, sid, (d) => { if (d.posts[id]) d.posts[id].warned = true; });
      await logProblem(engine, sid, "Scheduled post couldn't go out", `I couldn't post **#${id}** in <#${p.channelId}>. My role needs **Send Messages** and **Embed Links** there.`);
    }
    throw e;
  }
  if (!job.repeat) {
    write(engine, sid, (d) => { delete d.posts[id]; });
    return;
  }
  write(engine, sid, (d) => {
    const cur = d.posts[id];
    if (!cur) return;
    cur.runs = (Number(cur.runs) || 0) + 1;
    cur.lastSentAt = engine.scheduler.now();
    cur.warned = false;
  });
}

async function postPayload(engine, sid, p) {
  const text = await safeMentions(engine, sid, p.text);
  if (!p.embed) return { content: clip(text, MAX_POST_TEXT), embeds: undefined };
  let ping = '';
  if (p.embed.pingRoleId) {
    const roles = await engine.perms.roles(sid).catch(() => []);
    const r = roles.find((x) => x.id === p.embed.pingRoleId);
    if (canPing(r, sid)) ping = `<@&${r.id}>`;
  }
  const content = clip([ping, text].filter(Boolean).join(' '), MAX_POST_TEXT);
  return { content, embeds: [draftEmbed(p.embed)] };
}

async function adminPanelView(ctx) {
  const { engine, serverId: sid } = ctx;
  const doc = readDoc(engine, sid);
  const tagCount = Object.keys(doc.tags).length;
  const drafts = draftsOf(engine, sid, ctx.userId).length;
  const posts = postsOf(engine, sid);
  const paused = posts.filter((p) => p.paused).length;
  const now = engine.scheduler.now();
  const jobs = engine.scheduler.list({ kind: POST_KIND, serverId: sid });
  const next = jobs[0];
  const nextPost = next ? doc.posts[next.data?.postId] : null;
  const nextText = next ? ` · next ${whenText(next.at, nextPost?.repeat?.tz || nextPost?.tz || 'UTC', now)}` : '';
  const body = [
    'Saved answers, announcements and scheduled posts.',
    '',
    `🏷️ **Tags:** ${tagCount} of ${MAX_TAGS} · anyone posts one with **!name**`,
    `📝 **Your drafts:** ${drafts} of ${MAX_DRAFTS}`,
    `⏰ **Scheduled posts:** ${posts.length}${paused ? ` (${paused} paused)` : ''}${nextText}`,
  ].join('\n');
  return {
    embeds: [card({ title: `${ICONS.tools} Tools`, body, color: 'tools' })],
    components: [row(
      button('Tags', cid('ptags'), 'secondary', '🏷️'),
      button('New announcement', cid('enew'), 'primary', '📝'),
      button('My drafts', cid('edrafts', ctx.userId), 'secondary', '🗂️'),
      button('Scheduled posts', cid('slist'), 'secondary', '⏰'),
    )],
  };
}

async function panel(ctx) {
  const level = await ctx.level();
  if (isAdminLevel(ctx.engine, level)) return ctx.ephemeral(await adminPanelView(ctx));
  return ctx.ephemeral(tagListView(ctx.engine, ctx.serverId, 1, { isMod: ctx.engine.perms.atLeast(level, 'mod') }));
}

const admin = (run, extra = {}) => ({ perm: 'admin', ...extra, run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const ownDraft = (run) => admin(run, { owner: true, ownerArg: 0 });
const draftArg = (ctx) => Number(ctx.argv[1]);

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Tools',
  icon: ICONS.tools,
  description: 'Tags, an announcement builder and scheduled posts.',
  category: 'Utility',
  panelPerm: 'member',

  commands: {
    tag: { description: 'Saved answers: /tag rules posts it (or type !rules). Mods: /tag add rules Be nice!', run: runTag },
    embed: { description: 'Announcement builder (admins): /embed opens a form, /embed send #news posts your draft', perm: 'admin', run: runEmbed },
    schedule: { description: 'Scheduled posts (admins): /schedule #news every monday 9:00 Meeting!, /schedule list', perm: 'admin', run: runSchedule },
  },

  components: {
    tlist: { run: async (ctx) => {
      const isMod = ctx.engine.perms.atLeast(await ctx.level(), 'mod');
      const view = tagListView(ctx.engine, ctx.serverId, ctx.argv[0], { isMod });
      return onMessage(ctx) ? ctx.update(view) : ctx.ephemeral(view);
    } },
    ptags: { run: async (ctx) => {
      const isMod = ctx.engine.perms.atLeast(await ctx.level(), 'mod');
      const view = tagListView(ctx.engine, ctx.serverId, 1, { isMod });
      return onMessage(ctx) ? ctx.update(view) : ctx.ephemeral(view);
    } },
    tagsave: { perm: 'mod', run: (ctx) => addTag(ctx, cleanTagName(ctx.values?.name), ctx.values?.text) },
    tagedit: { perm: 'mod', run: (ctx) => addTag(ctx, cleanTagName(ctx.values?.name), ctx.values?.text, { editing: true }) },

    enew: admin((ctx) => draftForm(ctx, null)),
    esave: admin(saveFromForm),
    eimgsave: admin(saveImageForm),
    ecolsave: admin(saveColourForm),
    edrafts: ownDraft((ctx) => showView(ctx, draftsView(ctx.engine, ctx.serverId, ctx.userId))),
    eopen: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => showPreview(ctx, d))),
    eedit: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => draftForm(ctx, d))),
    eimage: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => {
      stateOf(ctx.engine).editing.set(editKey(ctx), { n: d.n });
      return ctx.form({ title: `Picture for draft #${d.n}`, action: 'eimgsave', fields: [{ id: 'image', label: 'Picture link (none to remove)', style: 'short', required: false, value: d.image || '', placeholder: 'https://i.imgur.com/abc.png', max: MAX_IMAGE }] });
    })),
    ecolours: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => ctx.update(colourView(d, ctx.userId)))),
    ecolour: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => {
      const colour = parseColour(ctx.argv[2]);
      if (!colour.ok) return showPreview(ctx, d, [`⚠️ ${colour.reason}`]);
      return showPreview(ctx, saveDraft(ctx.engine, ctx.serverId, ctx.userId, d.n, { color: colour.value }).draft);
    })),
    ecustom: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => {
      stateOf(ctx.engine).editing.set(editKey(ctx), { n: d.n });
      return ctx.form({ title: `Colour for draft #${d.n}`, action: 'ecolsave', fields: [{ id: 'colour', label: 'Colour (#ff8800 or a name like blue)', style: 'short', value: hexOf(d.color), max: 16 }] });
    })),
    esend: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => channelPicker(ctx, d))),
    epick: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => postDraft(ctx, d, Array.isArray(ctx.values) ? ctx.values[0] : null))),
    eto: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => postDraft(ctx, d, ctx.argv[2]))),
    eping: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => rolePicker(ctx, d))),
    erolepick: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => setPing(ctx, d, Array.isArray(ctx.values) ? ctx.values[0] : null))),
    erole: ownDraft((ctx) => draftOr(ctx, draftArg(ctx), (d) => setPing(ctx, d, ctx.argv[2]))),
    ediscard: ownDraft((ctx) => discardDraft(ctx, draftArg(ctx))),

    slist: admin((ctx) => showPosts(ctx)),
    snew: admin(scheduleForm),
    ssave: admin(saveScheduleForm),
    spause: admin((ctx) => pausePost(ctx, idFrom(ctx.argv[0]), { fromList: onMessage(ctx) })),
    sresume: admin((ctx) => resumePost(ctx, idFrom(ctx.argv[0]), { fromList: onMessage(ctx) })),
    scancel: admin((ctx) => cancelPost(ctx, idFrom(ctx.argv[0]), { fromList: onMessage(ctx) })),
  },

  events: {
    message: onChatTag,
  },

  jobs: {
    post: runPostJob,
  },

  yap: [
    { words: ['tag', 'tags'], run: runTag },
    { words: ['embed', 'announce', 'announcement'], run: runEmbed },
    { words: ['schedule', 'scheduled'], run: runSchedule },
  ],

  panel,

  help: [
    'Tags: anyone types **!rules** or **/tag rules**. Mods: /tag add rules Be nice to {user}! · /tag edit · /tag delete · /tag info rules · /tag list',
    'Announcements (admins): /embed opens a form with a live preview; change colour, picture or ping, then send it anywhere. Your last 5 drafts are kept: /embed list · /embed send 2 #news',
    "Scheduled posts (admins): /schedule #news every monday 9:00 Meeting! · daily 18:00 · in 2h · on 2026-12-25 10:00 · add tz Europe/London or embed 2. Uses the server's time zone by default.",
    '/schedule list shows the next times · /schedule pause 3 · /schedule resume 3 · /schedule cancel 3. A post whose channel was deleted pauses itself and tells the log channel.',
  ],

  dispose: (engine) => { states.delete(engine); },
});
